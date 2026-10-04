// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Experimental group escrow for native test tokens. Not audited.
/// @dev A slot is an address, not a verified person. Venue delivery is offchain.
contract CountMeIn {
    enum State { Open, Funded, Refunding, Paid }
    struct Plan {
        address organizer;
        address payable recipient;
        uint96 price;
        uint64 deadline;
        uint64 eventAt;
        uint16 target;
        uint16 joined;
        State state;
        bytes32 detailsHash;
    }
    uint256 public nextId;
    mapping(uint256 => Plan) public plans;
    mapping(uint256 => mapping(address => bool)) public hasJoined;
    mapping(uint256 => mapping(address => uint256)) public deposits;
    uint256 private locked = 1;

    error InvalidPlan();
    error WrongState();
    error Unauthorized();
    error WrongAmount();
    error AlreadyJoined();
    error NoDeposit();
    error TransferFailed();
    error Reentrant();

    event PlanCreated(uint256 indexed id, address indexed organizer, address indexed recipient, uint96 price, uint16 target, uint64 deadline, uint64 eventAt, bytes32 detailsHash);
    event Joined(uint256 indexed id, address indexed participant, uint256 amount);
    event Funded(uint256 indexed id);
    event Cancelled(uint256 indexed id);
    event Refunded(uint256 indexed id, address indexed participant, address indexed to, uint256 amount);
    event Collected(uint256 indexed id, address indexed recipient, uint256 amount);

    modifier nonReentrant() {
        if (locked != 1) revert Reentrant();
        locked = 2;
        _;
        locked = 1;
    }

    function createPlan(address payable recipient, uint96 price, uint16 target, uint64 deadline, uint64 eventAt, bytes32 detailsHash) external returns (uint256 id) {
        if (recipient == address(0) || price == 0 || target < 2 || target > 50 || deadline <= block.timestamp || eventAt <= deadline) revert InvalidPlan();
        id = nextId++;
        plans[id] = Plan(msg.sender, recipient, price, deadline, eventAt, target, 0, State.Open, detailsHash);
        emit PlanCreated(id, msg.sender, recipient, price, target, deadline, eventAt, detailsHash);
    }

    function stateOf(uint256 id) public view returns (State) {
        Plan storage p = plans[id];
        if (p.organizer == address(0)) revert InvalidPlan();
        if (p.state == State.Open && block.timestamp >= p.deadline) return State.Refunding;
        return p.state;
    }

    function join(uint256 id) external payable nonReentrant {
        Plan storage p = plans[id];
        if (stateOf(id) != State.Open) revert WrongState();
        if (msg.value != p.price) revert WrongAmount();
        if (hasJoined[id][msg.sender]) revert AlreadyJoined();
        hasJoined[id][msg.sender] = true;
        deposits[id][msg.sender] = msg.value;
        p.joined++;
        emit Joined(id, msg.sender, msg.value);
        if (p.joined == p.target) {
            p.state = State.Funded;
            emit Funded(id);
        }
    }

    function cancel(uint256 id) external {
        Plan storage p = plans[id];
        if (msg.sender != p.organizer) revert Unauthorized();
        if (stateOf(id) != State.Open) revert WrongState();
        p.state = State.Refunding;
        emit Cancelled(id);
    }

    /// @notice Claim your own deposit to an address you control. Never sends to an arbitrary caller.
    function claimRefund(uint256 id, address payable to) external nonReentrant {
        if (to == address(0)) revert InvalidPlan();
        if (stateOf(id) != State.Refunding) revert WrongState();
        uint256 amount = deposits[id][msg.sender];
        if (amount == 0) revert NoDeposit();
        deposits[id][msg.sender] = 0;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Refunded(id, msg.sender, to, amount);
    }

    /// @notice Anyone may trigger payment, but funds only go to the immutable recipient.
    function collect(uint256 id) external nonReentrant {
        Plan storage p = plans[id];
        if (stateOf(id) != State.Funded) revert WrongState();
        p.state = State.Paid;
        uint256 amount = uint256(p.price) * p.target;
        (bool ok,) = p.recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Collected(id, p.recipient, amount);
    }
}
