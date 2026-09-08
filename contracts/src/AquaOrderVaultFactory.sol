// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AquaOrderVault} from "./AquaOrderVault.sol";

/// @notice Enforces Ledger-owner delegations before relaying lifecycle actions to order vaults.
contract AquaOrderVaultFactory {
    bytes32 public constant DELEGATION_TYPEHASH = keccak256(
        "Delegation(address owner,address delegate,address token,uint256 maxPerOrder,uint256 maxPerDay,uint256 validUntil,uint256 nonce)"
    );
    bytes32 public constant ACTION_TYPEHASH = keccak256(
        "VaultAction(address vault,uint8 action,bytes32 strategyHash,bytes32 tokensHash,bytes32 amountsHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    struct Policy { uint128 maxPerOrder; uint128 maxPerDay; uint64 validUntil; bool active; }
    struct DailySpend { uint64 day; uint192 amount; }
    struct LifecycleRequest {
        AquaOrderVault vault;
        uint8 action;
        bytes strategy;
        address[] tokens;
        uint256[] amounts;
        uint256 deadline;
    }

    mapping(address owner => uint256 nonce) public delegationNonces;
    mapping(address delegate => uint256 nonce) public actionNonces;
    mapping(bytes32 policyKey => Policy policy) public policies;
    mapping(bytes32 policyKey => DailySpend spend) public dailySpend;
    mapping(address vault => bool registered) public vaults;

    error Unauthorized();
    error InvalidPolicy();
    error PolicyExceeded();
    error Expired();
    error InvalidAction();

    event DelegationRegistered(address indexed owner, address indexed delegate, address indexed token, uint256 validUntil);
    event DelegationRevoked(address indexed owner, address indexed delegate, address indexed token);
    event VaultDeployed(address indexed vault, address indexed owner, address indexed delegate, address token, bytes32 salt);
    event ActionExecuted(address indexed vault, uint8 indexed action, uint256 nonce);

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Aqua Ledger Agent Vault"), keccak256("1"), block.chainid, address(this)
        ));
    }

    function registerDelegation(
        address owner, address delegate, address token, uint128 maxPerOrder, uint128 maxPerDay,
        uint64 validUntil, bytes calldata signature
    ) external {
        if (
            owner == address(0) || delegate == address(0) || token == address(0)
            || maxPerOrder == 0 || maxPerDay < maxPerOrder
            // forge-lint: disable-next-line(block-timestamp)
            || validUntil <= block.timestamp
        ) revert InvalidPolicy();
        uint256 nonce = delegationNonces[owner]++;
        bytes32 structHash = keccak256(abi.encode(
            DELEGATION_TYPEHASH, owner, delegate, token, maxPerOrder, maxPerDay, validUntil, nonce
        ));
        // `_recover` only calls `ecrecover`, a precompile with no code of its own, so it
        // cannot reenter and reorder the state write or event below.
        if (_recover(_digest(structHash), signature) != owner) revert Unauthorized();
        policies[_policyKey(owner, delegate, token)] = Policy(maxPerOrder, maxPerDay, validUntil, true);
        // forge-lint: disable-next-line(reentrancy-events)
        emit DelegationRegistered(owner, delegate, token, validUntil);
    }

    function revokeDelegation(address delegate, address token) external {
        policies[_policyKey(msg.sender, delegate, token)].active = false;
        emit DelegationRevoked(msg.sender, delegate, token);
    }

    function deployVault(
        address owner, address delegate, address aqua, address app, address sellToken, bytes32 salt
    ) external returns (AquaOrderVault vault) {
        _activePolicy(owner, delegate, sellToken);
        // AquaOrderVault's constructor only stores its constructor arguments as immutables
        // and makes no external calls, so it cannot reenter this factory; the vault's address
        // is only known once `new` returns, so the state write and event must follow it.
        vault = new AquaOrderVault{salt: salt}(owner, delegate, aqua, app, sellToken);
        vaults[address(vault)] = true;
        // forge-lint: disable-next-line(reentrancy-events)
        emit VaultDeployed(address(vault), owner, delegate, sellToken, salt);
    }

    function predictVault(
        address owner, address delegate, address aqua, address app, address sellToken, bytes32 salt
    ) external view returns (address) {
        // This replicates the CREATE2 init-code-hash formula from EIP-1014
        // (keccak256(creationCode ++ abi.encode(constructorArgs))) exactly, so that it matches
        // the address Solidity derives for `new AquaOrderVault{salt}(...)` in deployVault
        // above. bytes.concat performs the same raw concatenation as abi.encodePacked would
        // here, without tripping the encodePacked hash-collision lint, which is aimed at
        // encodePacked used to build a disambiguating identifier from unrelated fields rather
        // than to reproduce a fixed, standard hash formula like this one.
        bytes32 initHash = keccak256(bytes.concat(
            type(AquaOrderVault).creationCode, abi.encode(owner, delegate, aqua, app, sellToken)
        ));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }

    /// @dev request.action 0 activates, 1 amends, and 2 cancels.
    function execute(LifecycleRequest calldata request, bytes calldata signature) external {
        if (!vaults[address(request.vault)]) revert InvalidAction();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > request.deadline) revert Expired();
        address delegate = request.vault.delegate();
        uint256 nonce = actionNonces[delegate]++;
        bytes32 structHash = keccak256(abi.encode(
            ACTION_TYPEHASH, address(request.vault), request.action, keccak256(request.strategy),
            keccak256(abi.encode(request.tokens)), keccak256(abi.encode(request.amounts)), nonce, request.deadline
        ));
        // `_recover` only calls `ecrecover`, a precompile with no code of its own, so it cannot
        // reenter and reorder the state or event below. `nonce` and `request.action` are
        // already final at this point, so the event can safely be emitted before the vault
        // calls further down without changing what it reports; if any branch reverts
        // (including the invalid-action case) the emitted log is discarded along with the rest
        // of the transaction, exactly as if it were emitted afterwards.
        if (_recover(_digest(structHash), signature) != delegate) revert Unauthorized();
        // forge-lint: disable-next-line(reentrancy-events)
        emit ActionExecuted(address(request.vault), request.action, nonce);
        if (request.action == 0 || request.action == 1) {
            if (request.amounts.length != 2) revert InvalidAction();
            uint256 oldAmount = request.vault.committedAmount();
            uint256 newAmount = request.amounts[1];
            uint256 increase = newAmount > oldAmount ? newAmount - oldAmount : 0;
            _charge(request.vault.owner(), delegate, request.vault.sellToken(), newAmount, increase);
            if (request.action == 0) request.vault.activate(request.strategy, request.tokens, request.amounts);
            else request.vault.amend(request.strategy, request.tokens, request.amounts);
        } else if (request.action == 2) {
            request.vault.cancel(request.tokens);
        } else {
            revert InvalidAction();
        }
    }

    function _charge(address owner, address delegate, address token, uint256 orderAmount, uint256 increase) private {
        bytes32 key = _policyKey(owner, delegate, token);
        Policy memory policy = _activePolicy(owner, delegate, token);
        if (orderAmount > policy.maxPerOrder) revert PolicyExceeded();
        DailySpend storage spend = dailySpend[key];
        // casting to 'uint64' is safe because block.timestamp / 1 days ("days since the Unix
        // epoch") stays far below type(uint64).max for billions of years.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 day = uint64(block.timestamp / 1 days);
        if (spend.day != day) { spend.day = day; spend.amount = 0; }
        uint256 next = uint256(spend.amount) + increase;
        if (next > policy.maxPerDay) revert PolicyExceeded();
        // casting to 'uint192' is safe because the check immediately above guarantees
        // next <= policy.maxPerDay, and policy.maxPerDay is a uint128, well within uint192.
        // forge-lint: disable-next-line(unsafe-typecast)
        spend.amount = uint192(next);
    }

    function _activePolicy(address owner, address delegate, address token) private view returns (Policy memory policy) {
        policy = policies[_policyKey(owner, delegate, token)];
        // forge-lint: disable-next-line(block-timestamp)
        if (!policy.active || policy.validUntil < block.timestamp) revert Expired();
    }

    function _policyKey(address owner, address delegate, address token) private pure returns (bytes32) {
        return keccak256(abi.encode(owner, delegate, token));
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", DOMAIN_SEPARATOR, structHash));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r; bytes32 s; uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v > 28 || uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) {
            return address(0);
        }
        return ecrecover(digest, v, r, s);
    }
}
