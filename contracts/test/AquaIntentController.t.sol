// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AquaIntentController} from "../src/AquaIntentController.sol";

contract AquaIntentControllerTest {
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
}
