// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AquaOrderVault} from "../src/AquaOrderVault.sol";
import {AquaOrderVaultFactory} from "../src/AquaOrderVaultFactory.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract DelegationMockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address recipient, uint256 amount) external { balanceOf[recipient] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address recipient, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[recipient] += amount; return true;
    }
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        uint256 permitted = allowance[sender][msg.sender]; require(permitted >= amount, "allowance");
        allowance[sender][msg.sender] = permitted - amount; balanceOf[sender] -= amount; balanceOf[recipient] += amount; return true;
    }
}

contract DelegationMockRouter {
    struct Order { address maker; uint256 traits; bytes data; }
    function swap(Order calldata, address tokenIn, address tokenOut, uint256 amount, bytes calldata) external returns (uint256) {
        DelegationMockToken(tokenIn).transferFrom(msg.sender, address(this), amount);
        DelegationMockToken(tokenOut).mint(msg.sender, amount * 2);
        return amount * 2;
    }
}

contract DelegationMockAqua {
    function ship(address, bytes calldata, address[] calldata, uint256[] calldata) external {}
    function dock(address, bytes32, address[] calldata) external {}
}

contract AquaOrderVaultDelegationTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant OWNER_KEY = 0xA11CE;
    uint256 private constant AGENT_KEY = 0xB0B;

    function testReregisterDelegationResetsDailySpend() external {
        address owner = vm.addr(OWNER_KEY);
        address agent = vm.addr(AGENT_KEY);
        DelegationMockToken token = new DelegationMockToken();
        DelegationMockToken quote = new DelegationMockToken();
        AquaOrderVaultFactory factory = new AquaOrderVaultFactory();
        _register(factory, owner, agent, address(token), 0);
        AquaOrderVault vault = factory.deployVault(
            owner, agent, address(new DelegationMockAqua()), address(new DelegationMockRouter()), address(token), bytes32(uint256(11))
        );
        token.mint(address(vault), 200);
        _swap(factory, vault, token, quote, bytes32(uint256(3)));
        bool exhausted = false;
        try this.swap(factory, vault, token, quote, bytes32(uint256(4))) { exhausted = true; } catch { }
        require(!exhausted, "exhausted daily spend was accepted");
        _register(factory, owner, agent, address(token), 1);
        _swap(factory, vault, token, quote, bytes32(uint256(4)));
        // forge-lint: disable-next-line(incorrect-strict-equality)
        require(quote.balanceOf(owner) == 400, "re-registered daily budget did not allow the next vault action");
    }

    function swap(
        AquaOrderVaultFactory factory, AquaOrderVault vault, DelegationMockToken token, DelegationMockToken quote, bytes32 nonce
    ) external {
        _swap(factory, vault, token, quote, nonce);
    }

    function _register(AquaOrderVaultFactory factory, address owner, address agent, address token, uint256 nonce) private {
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 validUntil = uint64(block.timestamp + 1 days);
        bytes32 delegation = keccak256(abi.encode(
            factory.DELEGATION_TYPEHASH(), owner, agent, token, uint256(100), uint256(100), uint256(validUntil), nonce
        ));
        factory.registerDelegation(owner, agent, token, 100, 100, validUntil, _signature(OWNER_KEY, _digest(factory.DOMAIN_SEPARATOR(), delegation)));
    }

    function _swap(
        AquaOrderVaultFactory factory, AquaOrderVault vault, DelegationMockToken token, DelegationMockToken quote, bytes32 nonce
    ) private {
        DelegationMockRouter.Order memory order = DelegationMockRouter.Order(address(vault), 1 << 254, hex"01");
        bytes memory callData = abi.encodeCall(DelegationMockRouter.swap, (order, address(token), address(quote), 100, bytes("")));
        address[] memory tokens = new address[](2); tokens[0] = address(quote); tokens[1] = address(token);
        uint256[] memory amounts = new uint256[](2); amounts[0] = 190; amounts[1] = 100;
        AquaOrderVaultFactory.LifecycleRequest memory request = AquaOrderVaultFactory.LifecycleRequest({
            vault: vault, action: 3, strategy: callData, tokens: tokens, amounts: amounts, nonce: nonce, deadline: block.timestamp + 60
        });
        factory.execute(request, _action(factory, request));
    }

    function _action(AquaOrderVaultFactory factory, AquaOrderVaultFactory.LifecycleRequest memory request) private returns (bytes memory) {
        bytes32 message = keccak256(abi.encode(
            factory.ACTION_TYPEHASH(), address(request.vault), request.action, keccak256(request.strategy),
            keccak256(abi.encode(request.tokens)), keccak256(abi.encode(request.amounts)), request.nonce, request.deadline
        ));
        return _signature(AGENT_KEY, _digest(factory.DOMAIN_SEPARATOR(), message));
    }

    function _digest(bytes32 domain, bytes32 message) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domain, message));
    }

    function _signature(uint256 key, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
