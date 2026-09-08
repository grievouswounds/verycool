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

    event Activated(bytes32 indexed orderHash, uint256 committedAmount);
    event Amended(bytes32 indexed previousOrderHash, bytes32 indexed orderHash, uint256 committedAmount);
    event Cancelled(bytes32 indexed orderHash);
    event Withdrawn(address indexed token, address indexed recipient, uint256 amount);

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
        external onlyFactory nonReentrant
    {
        if (activeOrderHash != bytes32(0)) revert ActiveOrder();
        uint256 amount = _validate(strategy, tokens, amounts);
        if (IERC20VaultAsset(sellToken).balanceOf(address(this)) < amount) revert InsufficientFunding();
        _approveAqua(amount);
        aqua.ship(app, strategy, tokens, amounts);
        activeOrderHash = keccak256(strategy);
        committedAmount = amount;
        emit Activated(activeOrderHash, amount);
    }

    function amend(bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external onlyFactory nonReentrant
    {
        bytes32 previous = activeOrderHash;
        if (previous == bytes32(0)) revert InvalidOrder();
        uint256 amount = _validate(strategy, tokens, amounts);
        if (IERC20VaultAsset(sellToken).balanceOf(address(this)) < amount) revert InsufficientFunding();
        aqua.dock(app, previous, tokens);
        _approveAqua(amount);
        aqua.ship(app, strategy, tokens, amounts);
        activeOrderHash = keccak256(strategy);
        committedAmount = amount;
        emit Amended(previous, activeOrderHash, amount);
    }

    function cancel(address[] calldata tokens) external onlyFactory nonReentrant {
        _cancel(tokens);
    }

    function emergencyCancel(address[] calldata tokens) external onlyOwner nonReentrant {
        _cancel(tokens);
    }

    function withdraw(address token, address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert InvalidOrder();
        uint256 balance = IERC20VaultAsset(token).balanceOf(address(this));
        if (token == sellToken && activeOrderHash != bytes32(0)) {
            uint256 available = balance > committedAmount ? balance - committedAmount : 0;
            if (available < amount) revert ActiveOrder();
        }
        _safeTransfer(token, recipient, amount);
        emit Withdrawn(token, recipient, amount);
    }

    function _cancel(address[] calldata tokens) private {
        bytes32 current = activeOrderHash;
        if (current == bytes32(0)) revert InvalidOrder();
        aqua.dock(app, current, tokens);
        activeOrderHash = bytes32(0);
        committedAmount = 0;
        _approveAqua(0);
        emit Cancelled(current);
    }

    function _validate(bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        private view returns (uint256 amount)
    {
        if (tokens.length != 2 || amounts.length != 2 || tokens[1] != sellToken || amounts[0] != 0) {
            revert InvalidOrder();
        }
        Order memory order = abi.decode(strategy, (Order));
        if (order.maker != address(this) || order.data.length == 0) revert InvalidOrder();
        amount = amounts[1];
        if (amount == 0) revert InvalidOrder();
    }

    function _approveAqua(uint256 amount) private {
        (bool ok, bytes memory result) = sellToken.call(abi.encodeCall(IERC20VaultAsset.approve, (address(aqua), amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }

    function _safeTransfer(address token, address recipient, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(abi.encodeCall(IERC20VaultAsset.transfer, (recipient, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}
