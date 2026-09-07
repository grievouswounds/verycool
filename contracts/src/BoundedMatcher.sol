// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Executes a bounded, explicitly allowlisted sequence of matcher calls.
/// @dev Candidate pricing remains the router's responsibility; arbitrary targets and selectors are rejected.
contract BoundedMatcher {
    address public immutable operator;
    mapping(address target => mapping(bytes4 selector => bool allowed)) public allowed;

    error Unauthorized();
    error InvalidBatch();
    error CallRejected(uint256 index);

    constructor(address operator_, address[] memory targets, bytes4[] memory selectors) {
        if (operator_ == address(0) || targets.length != selectors.length) revert InvalidBatch();
        operator = operator_;
        for (uint256 index; index < targets.length; ++index) allowed[targets[index]][selectors[index]] = true;
    }

    function execute(address[] calldata targets, bytes[] calldata calls) external {
        if (msg.sender != operator) revert Unauthorized();
        if (targets.length == 0 || targets.length > 8 || targets.length != calls.length) revert InvalidBatch();
        for (uint256 index; index < targets.length; ++index) {
            bytes calldata callData = calls[index];
            if (callData.length < 4 || !allowed[targets[index]][bytes4(callData[:4])]) revert CallRejected(index);
            (bool ok,) = targets[index].call(callData);
            if (!ok) revert CallRejected(index);
        }
    }
}
