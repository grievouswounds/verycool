// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IAquaOrderBook {
    function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts) external;
    function dock(address app, bytes32 strategyHash, address[] calldata tokens) external;
}

interface IERC20VaultAsset {
    function balanceOf(address owner) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

/// @notice A non-upgradeable, single-order Aqua maker owned by a Ledger account.
contract AquaOrderVault {
    struct Order { address maker; uint256 traits; bytes data; }

    address public immutable factory;
    address public immutable owner;
    address public immutable delegate;
    IAquaOrderBook public immutable aqua;
    address public immutable app;
    address public immutable sellToken;

    bytes32 public activeOrderHash;
    uint256 public committedAmount;
    bool private entered;

    error Unauthorized();
    error InvalidOrder();
    error InsufficientFunding();
    error ActiveOrder();
    error TransferFailed();
    error SwapFailed();

    event Activated(bytes32 indexed orderHash, uint256 committedAmount);
    event Amended(bytes32 indexed previousOrderHash, bytes32 indexed orderHash, uint256 committedAmount);
    event Cancelled(bytes32 indexed orderHash);
    event Withdrawn(address indexed token, address indexed recipient, uint256 amount);
    event SwapExecuted(address indexed sellToken, address indexed buyToken, uint256 sellAmount, uint256 buyAmount);

    modifier onlyFactory() { if (msg.sender != factory) revert Unauthorized(); _; }
    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    modifier nonReentrant() { if (entered) revert Unauthorized(); entered = true; _; entered = false; }

    constructor(address owner_, address delegate_, address aqua_, address app_, address sellToken_) {
        if (owner_ == address(0) || delegate_ == address(0) || aqua_ == address(0)
            || app_ == address(0) || sellToken_ == address(0)) revert InvalidOrder();
        factory = msg.sender;
        owner = owner_;
        delegate = delegate_;
        aqua = IAquaOrderBook(aqua_);
        app = app_;
        sellToken = sellToken_;
    }

    function activate(bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external nonReentrant onlyFactory
    {
        if (activeOrderHash != bytes32(0)) revert ActiveOrder();
        uint256 amount = _validate(strategy, tokens, amounts);
        if (IERC20VaultAsset(sellToken).balanceOf(address(this)) < amount) revert InsufficientFunding();
        bytes32 orderHash = keccak256(strategy);
        activeOrderHash = orderHash;
        committedAmount = amount;
        emit Activated(orderHash, amount);
        _approveAqua(amount);
        // nonReentrant already set `entered = true` before this function body started running,
        // so a reentrant call back into any nonReentrant-guarded function reverts immediately
        // regardless of statement order within the body.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        aqua.ship(app, strategy, tokens, amounts);
    }

    function amend(bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external nonReentrant onlyFactory
    {
        bytes32 previous = activeOrderHash;
        if (previous == bytes32(0)) revert InvalidOrder();
        uint256 amount = _validate(strategy, tokens, amounts);
        if (IERC20VaultAsset(sellToken).balanceOf(address(this)) < amount) revert InsufficientFunding();
        bytes32 orderHash = keccak256(strategy);
        activeOrderHash = orderHash;
        committedAmount = amount;
        emit Amended(previous, orderHash, amount);
        // nonReentrant already set `entered = true` before this function body started running,
        // so a reentrant call back into any nonReentrant-guarded function reverts immediately
        // regardless of statement order within the body.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        aqua.dock(app, previous, tokens);
        _approveAqua(amount);
        // forge-lint: disable-next-line(reentrancy-no-eth)
        aqua.ship(app, strategy, tokens, amounts);
    }

    function cancel(address[] calldata tokens) external nonReentrant onlyFactory {
        _cancel(tokens);
    }

    /// @notice Executes exactly one Aqua swap calldata reviewed and signed by the delegate.
    /// The immutable `app` is the only target, the sell approval is exact and cleared after
    /// the call, and all measured output is transferred directly to the Ledger owner.
    function executeSwap(bytes calldata callData, address[] calldata tokens, uint256[] calldata amounts)
        external nonReentrant onlyFactory
    {
        if (activeOrderHash != bytes32(0) || tokens.length != 2 || amounts.length != 2
            || tokens[1] != sellToken || tokens[0] == sellToken || amounts[0] == 0 || amounts[1] == 0
            || callData.length < 4) revert InvalidOrder();
        bytes4 reviewedSelector;
        assembly ("memory-safe") { reviewedSelector := calldataload(callData.offset) }
        if (reviewedSelector != bytes4(keccak256("swap((address,uint256,bytes),address,address,uint256,bytes)"))) {
            revert InvalidOrder();
        }
        uint256 beforeOutput = IERC20VaultAsset(tokens[0]).balanceOf(address(this));
        _safeApprove(sellToken, app, amounts[1]);
        // The target and selector are both immutable/allowlisted above and nonReentrant is
        // already active. A revert is propagated and therefore cannot leave partial state.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        (bool ok, bytes memory result) = app.call(callData);
        _safeApprove(sellToken, app, 0);
        if (!ok) {
            assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
        uint256 afterOutput = IERC20VaultAsset(tokens[0]).balanceOf(address(this));
        if (afterOutput < beforeOutput || afterOutput - beforeOutput < amounts[0]) revert SwapFailed();
        uint256 output = afterOutput - beforeOutput;
        emit SwapExecuted(sellToken, tokens[0], amounts[1], output);
        _safeTransfer(tokens[0], owner, output);
    }

    function emergencyCancel(address[] calldata tokens) external nonReentrant onlyOwner {
        _cancel(tokens);
    }

    /// @notice Returns listed token balances to the immutable Ledger owner. The factory is the
    /// only caller, so an agent-signed action cannot choose a different recipient.
    function returnToOwner(address[] calldata tokens) external nonReentrant onlyFactory {
        if (activeOrderHash != bytes32(0) || tokens.length == 0) revert InvalidOrder();
        for (uint256 index = 0; index < tokens.length; ++index) {
            address token = tokens[index];
            uint256 amount = IERC20VaultAsset(token).balanceOf(address(this));
            if (amount == 0) continue;
            emit Withdrawn(token, owner, amount);
            _safeTransfer(token, owner, amount);
        }
    }

    function withdraw(address token, address recipient, uint256 amount) external nonReentrant onlyOwner {
        if (recipient == address(0)) revert InvalidOrder();
        uint256 balance = IERC20VaultAsset(token).balanceOf(address(this));
        if (token == sellToken && activeOrderHash != bytes32(0)) {
            uint256 available = balance > committedAmount ? balance - committedAmount : 0;
            if (available < amount) revert ActiveOrder();
        }
        emit Withdrawn(token, recipient, amount);
        _safeTransfer(token, recipient, amount);
    }

    function _cancel(address[] calldata tokens) private {
        bytes32 current = activeOrderHash;
        if (current == bytes32(0)) revert InvalidOrder();
        activeOrderHash = bytes32(0);
        committedAmount = 0;
        emit Cancelled(current);
        // Both callers of _cancel (cancel, emergencyCancel) carry the nonReentrant modifier,
        // which already set `entered = true` before this function body started running, so a
        // reentrant call back into any nonReentrant-guarded function reverts immediately.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        aqua.dock(app, current, tokens);
        _approveAqua(0);
    }

    function _validate(bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        private view returns (uint256 amount)
    {
        if (tokens.length != 2 || amounts.length != 2 || tokens[1] != sellToken || amounts[0] == 0) {
            revert InvalidOrder();
        }
        // amounts[0] is the virtual buy/rate reserve Aqua quote loads; amounts[1] is sell inventory.
        Order memory order = abi.decode(strategy, (Order));
        if (order.maker != address(this) || order.data.length == 0) revert InvalidOrder();
        amount = amounts[1];
        if (amount == 0) revert InvalidOrder();
    }

    function _approveAqua(uint256 amount) private {
        _safeApprove(sellToken, address(aqua), amount);
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(abi.encodeCall(IERC20VaultAsset.approve, (spender, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }

    function _safeTransfer(address token, address recipient, uint256 amount) private {
        // Callers (`withdraw` and `returnToOwner`) carry the `nonReentrant` modifier, which sets
        // `entered = true` before the function body (and therefore this call) runs; a
        // reentrant call back into any nonReentrant-guarded function reverts immediately.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        (bool ok, bytes memory result) = token.call(abi.encodeCall(IERC20VaultAsset.transfer, (recipient, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}
