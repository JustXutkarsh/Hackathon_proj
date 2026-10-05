// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
interface Escrow {
    function join(uint256) external payable;
    function collect(uint256) external;
    function collectTo(uint256,address payable) external;
    function claimRefund(uint256,address payable) external;
}
contract Receiver {
    Escrow immutable escrow;
    address immutable controller;
    bool public rejectTransfer;
    bool public reentryBlocked;
    uint256 currentPlan;
    uint8 attack;
    constructor(address target) { escrow=Escrow(target); controller=msg.sender; }
    modifier onlyController() { require(msg.sender==controller); _; }
    function configure(bool reject,uint8 mode,uint256 id) external onlyController { rejectTransfer=reject; attack=mode; currentPlan=id; }
    function join(uint256 id) external payable onlyController { escrow.join{value:msg.value}(id); }
    function refund(uint256 id,address payable to) external onlyController { escrow.claimRefund(id,to); }
    function redirect(uint256 id,address payable to) external onlyController { escrow.collectTo(id,to); }
    receive() external payable {
        require(!rejectTransfer,"Receiver rejected transfer");
        if(attack!=0) {
            bytes memory data=attack==1?abi.encodeCall(Escrow.claimRefund,(currentPlan,payable(address(this)))):abi.encodeCall(Escrow.collect,(currentPlan));
            (bool ok,)=address(escrow).call(data);
            require(!ok,"Reentry unexpectedly succeeded"); reentryBlocked=true;
        }
    }
}
