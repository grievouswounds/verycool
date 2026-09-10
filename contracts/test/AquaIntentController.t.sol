// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AquaIntentController} from "../src/AquaIntentController.sol";

interface Vm {
    function prank(address sender) external;
}

contract AquaIntentControllerTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testDomainAndDigestAreBoundToDeployment() external {
        AquaIntentController controller = new AquaIntentController(address(this), 2, 30);
        bytes32 digest = controller.intentDigest(
            address(0x1234), bytes32(uint256(1)), bytes32(uint256(2)), block.timestamp + 60
        );
        require(digest != bytes32(0), "zero digest");
        require(controller.minimumBlocks() == 2, "wrong block persistence");
        require(controller.minimumDelay() == 30, "wrong time persistence");
    }

    function testFalseObservationResetsTheWindow() external {
        AquaIntentController controller = new AquaIntentController(address(this), 2, 30);
        bytes32 intent = bytes32(uint256(1));
        controller.observe(intent, bytes32(uint256(2)), true);
        (uint64 timestamp, uint64 firstBlock, bytes32 proof) = controller.observations(intent);
        require(timestamp != 0 && firstBlock != 0 && proof != bytes32(0), "observation missing");
        controller.observe(intent, bytes32(0), false);
        (timestamp, firstBlock, proof) = controller.observations(intent);
        require(timestamp == 0 && firstBlock == 0 && proof == bytes32(0), "observation not reset");
    }

    function testBoundMatcherCanActivateAfterPersistence() external {
        AquaIntentController controller = new AquaIntentController(address(this), 0, 0);
        address matcher = address(0xCAFE);
        controller.bindMatcher(matcher);
        bytes32 intent = bytes32(uint256(1));
        bytes32 proof = bytes32(uint256(2));
        bytes32 group = bytes32(uint256(3));
        controller.observe(intent, proof, true);
        vm.prank(matcher);
        controller.activate(intent, group, proof);
        require(controller.closedGroups(group), "group not closed");
    }

    function testStrangerCannotActivate() external {
        AquaIntentController controller = new AquaIntentController(address(this), 0, 0);
        controller.bindMatcher(address(0xCAFE));
        bytes32 intent = bytes32(uint256(1));
        bytes32 proof = bytes32(uint256(2));
        controller.observe(intent, proof, true);
        vm.prank(address(0xBEEF));
        try controller.activate(intent, bytes32(uint256(3)), proof) {
            revert("stranger activated");
        } catch {}
    }

    function testBindMatcherCannotBeCalledTwiceOrByNonDeployer() external {
        AquaIntentController controller = new AquaIntentController(address(this), 0, 0);
        controller.bindMatcher(address(0xCAFE));
        try controller.bindMatcher(address(0xF00D)) {
            revert("matcher rebound");
        } catch {}
        require(controller.matcher() == address(0xCAFE), "matcher changed");
        AquaIntentController other = new AquaIntentController(address(this), 0, 0);
        vm.prank(address(0xBEEF));
        try other.bindMatcher(address(0xCAFE)) {
            revert("non-deployer bound matcher");
        } catch {}
        require(other.matcher() == address(0), "stranger bound matcher");
    }
}
