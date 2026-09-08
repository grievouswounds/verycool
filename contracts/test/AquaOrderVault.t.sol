// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AquaOrderVault} from "../src/AquaOrderVault.sol";
import {AquaOrderVaultFactory} from "../src/AquaOrderVaultFactory.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
}

contract MockVaultToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address recipient, uint256 amount) external { balanceOf[recipient] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address recipient, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[recipient] += amount; return true;
    }
}

contract MockAquaOrderBook {
    uint256 public ships;
    uint256 public docks;
    function ship(address, bytes calldata, address[] calldata, uint256[] calldata) external { ships += 1; }
    function dock(address, bytes32, address[] calldata) external { docks += 1; }
}

contract AquaOrderVaultTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant OWNER_KEY = 0xA11CE;
    uint256 private constant AGENT_KEY = 0xB0B;

    function testLedgerPolicyFundsActivatesCancelsAndWithdraws() external {
        address owner = vm.addr(OWNER_KEY);
        address agent = vm.addr(AGENT_KEY);
        MockVaultToken token = new MockVaultToken();
        MockVaultToken quote = new MockVaultToken();
        MockAquaOrderBook aqua = new MockAquaOrderBook();
        AquaOrderVaultFactory factory = new AquaOrderVaultFactory();

        uint64 validUntil = uint64(block.timestamp + 1 days);
        bytes32 delegation = keccak256(abi.encode(
            factory.DELEGATION_TYPEHASH(), owner, agent, address(token), uint256(100), uint256(200),
            uint256(validUntil), uint256(0)
        ));
        factory.registerDelegation(owner, agent, address(token), 100, 200, validUntil,
            _signature(OWNER_KEY, _digest(factory.DOMAIN_SEPARATOR(), delegation)));

        AquaOrderVault vault = factory.deployVault(
            owner, agent, address(aqua), address(0xA9), address(token), bytes32(uint256(7))
        );
        token.mint(address(vault), 100);
        bytes memory strategy = abi.encode(AquaOrderVault.Order(address(vault), 1 << 254, hex"0102"));
        address[] memory tokens = new address[](2);
        tokens[0] = address(quote); tokens[1] = address(token);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 0; amounts[1] = 100;
        uint256 deadline = block.timestamp + 60;
        AquaOrderVaultFactory.LifecycleRequest memory request = AquaOrderVaultFactory.LifecycleRequest({
            vault: vault, action: 0, strategy: strategy, tokens: tokens, amounts: amounts, deadline: deadline
        });
        factory.execute(request, _actionSignature(factory, request, AGENT_KEY, 0));
        require(aqua.ships() == 1 && vault.committedAmount() == 100, "order not activated");

        request.action = 2;
        request.strategy = "";
        request.amounts = new uint256[](0);
        factory.execute(request, _actionSignature(factory, request, AGENT_KEY, 1));
        require(aqua.docks() == 1 && vault.activeOrderHash() == bytes32(0), "order not cancelled");

        vm.prank(owner);
        vault.withdraw(address(token), owner, 100);
        require(token.balanceOf(owner) == 100, "owner did not recover funds");
    }

    function _actionSignature(
        AquaOrderVaultFactory factory, AquaOrderVaultFactory.LifecycleRequest memory request,
        uint256 key, uint256 nonce
    ) private returns (bytes memory) {
        bytes32 message = keccak256(abi.encode(
            factory.ACTION_TYPEHASH(), address(request.vault), request.action, keccak256(request.strategy),
            keccak256(abi.encode(request.tokens)), keccak256(abi.encode(request.amounts)), nonce, request.deadline
        ));
        return _signature(key, _digest(factory.DOMAIN_SEPARATOR(), message));
    }

    function _digest(bytes32 domain, bytes32 message) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domain, message));
    }

    function _signature(uint256 key, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
