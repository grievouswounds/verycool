// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BoundedMatcher} from "../src/BoundedMatcher.sol";

contract MatcherTarget {
    uint256 public value;
    function setValue(uint256 next) external { value = next; }
}

contract BoundedMatcherTest {
    function testExecutesOnlyConfiguredTargetAndSelector() external {
        MatcherTarget target = new MatcherTarget();
        address[] memory targets = new address[](1); targets[0] = address(target);
        bytes4[] memory selectors = new bytes4[](1); selectors[0] = target.setValue.selector;
        BoundedMatcher matcher = new BoundedMatcher(address(this), targets, selectors);
        bytes[] memory calls = new bytes[](1); calls[0] = abi.encodeCall(target.setValue, (7));
        matcher.execute(targets, calls);
        require(target.value() == 7, "call not executed");
    }

    function testRejectsUnconfiguredSelector() external {
        MatcherTarget target = new MatcherTarget();
        address[] memory targets = new address[](1); targets[0] = address(target);
        bytes4[] memory selectors = new bytes4[](1); selectors[0] = target.setValue.selector;
        BoundedMatcher matcher = new BoundedMatcher(address(this), targets, selectors);
        bytes[] memory calls = new bytes[](1); calls[0] = abi.encodeWithSignature("value()");
        (bool ok,) = address(matcher).call(abi.encodeCall(matcher.execute, (targets, calls)));
        require(!ok, "unconfigured selector accepted");
    }
}
