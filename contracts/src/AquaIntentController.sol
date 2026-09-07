// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Narrow authorization and trigger registry for pre-shipped Aqua programs.
/// @dev This contract never holds tokens and cannot act as an Aqua maker. A production
/// deployment requires an independent audit and an immutable, reviewed router allowlist.
contract AquaIntentController {
    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "AquaIntent(address maker,bytes32 commandHash,bytes32 nonce,uint256 validBefore)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;
    address public immutable operator;
    uint64 public immutable minimumDelay;
    uint64 public immutable minimumBlocks;

    struct Observation {
        uint64 firstTimestamp;
        uint64 firstBlock;
        bytes32 proofHash;
    }

    mapping(address maker => mapping(bytes32 nonce => bool used)) public nonceUsed;
    mapping(bytes32 intentHash => Observation observation) public observations;
    mapping(bytes32 group => bool closed) public closedGroups;

    error Unauthorized();
    error Expired();
    error Replay();
    error TriggerNotPersistent();
    error GroupClosed();

    event IntentConsumed(bytes32 indexed intentHash, address indexed maker, bytes32 indexed nonce);
    event TriggerObserved(bytes32 indexed intentHash, bytes32 proofHash, uint64 blockNumber, uint64 timestamp);
    event TriggerReset(bytes32 indexed intentHash);
    event TriggerActivated(bytes32 indexed intentHash, bytes32 indexed group);

    constructor(address operator_, uint64 minimumBlocks_, uint64 minimumDelay_) {
        if (operator_ == address(0)) revert Unauthorized();
        operator = operator_;
        minimumBlocks = minimumBlocks_;
        minimumDelay = minimumDelay_;
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Aqua Agent Order Book"), keccak256("1"), block.chainid, address(this)
        ));
    }

    function intentDigest(address maker, bytes32 commandHash, bytes32 nonce, uint256 validBefore)
        public view returns (bytes32)
    {
        bytes32 message = keccak256(abi.encode(INTENT_TYPEHASH, maker, commandHash, nonce, validBefore));
        return keccak256(abi.encodePacked(hex"1901", DOMAIN_SEPARATOR, message));
    }

    function consume(address maker, bytes32 commandHash, bytes32 nonce, uint256 validBefore, bytes calldata signature)
        external returns (bytes32 digest)
    {
        if (block.timestamp > validBefore) revert Expired();
        if (nonceUsed[maker][nonce]) revert Replay();
        digest = intentDigest(maker, commandHash, nonce, validBefore);
        if (!_validSignature(maker, digest, signature)) revert Unauthorized();
        nonceUsed[maker][nonce] = true;
        emit IntentConsumed(digest, maker, nonce);
    }

    function observe(bytes32 intentHash, bytes32 proofHash, bool conditionTrue) external {
        if (msg.sender != operator) revert Unauthorized();
        Observation storage current = observations[intentHash];
        if (!conditionTrue) {
            delete observations[intentHash];
            emit TriggerReset(intentHash);
        } else if (current.proofHash != proofHash) {
            observations[intentHash] = Observation(uint64(block.timestamp), uint64(block.number), proofHash);
            emit TriggerObserved(intentHash, proofHash, uint64(block.number), uint64(block.timestamp));
        }
    }

    function activate(bytes32 intentHash, bytes32 group, bytes32 proofHash) external {
        if (msg.sender != operator) revert Unauthorized();
        if (closedGroups[group]) revert GroupClosed();
        Observation memory current = observations[intentHash];
        if (current.proofHash != proofHash || block.number < uint256(current.firstBlock) + minimumBlocks
            || block.timestamp < uint256(current.firstTimestamp) + minimumDelay) revert TriggerNotPersistent();
        closedGroups[group] = true;
        delete observations[intentHash];
        emit TriggerActivated(intentHash, group);
    }

    function _validSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (signer.code.length != 0) {
            (bool ok, bytes memory result) = signer.staticcall(
                abi.encodeWithSelector(bytes4(keccak256("isValidSignature(bytes32,bytes)")), digest, signature)
            );
            return ok && result.length >= 32 && bytes4(result) == 0x1626ba7e;
        }
        if (signature.length != 65) return false;
        bytes32 r; bytes32 s; uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        return v <= 28 && uint256(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0
            && ecrecover(digest, v, r, s) == signer;
    }
}

