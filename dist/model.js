export function status(plan, now=Date.now()) {
  if(plan.cancelled) return 'refundable';
  if(plan.members.length >= plan.target) return 'funded';
  return now >= plan.deadline ? 'refundable' : 'open';
}
export function validatePlan(p, now=Date.now()) {
  if(!p.title.trim() || p.title.length>70) throw Error('Give your plan a name of up to 70 characters.');
  if(!p.location.trim() || p.location.length>90) throw Error('Add a location of up to 90 characters.');
  if(!['sport','outing','social'].includes(p.category)) throw Error('Choose an activity.');
  if(!Number.isSafeInteger(p.amount) || p.amount<1 || p.amount>10000) throw Error('Choose 1–10,000 whole demo credits per person.');
  if(!Number.isInteger(p.target) || p.target<2 || p.target>50) throw Error('Choose between 2 and 50 people.');
  if(!Number.isFinite(p.deadline) || p.deadline<=now) throw Error('Choose a future funding deadline.');
  if(!Number.isFinite(p.eventAt) || p.eventAt<=p.deadline) throw Error('The activity must start after its funding deadline.');
  return p;
}
export function join(plan,user,now=Date.now()) {
  if(status(plan,now)!=='open') throw Error('This plan is no longer accepting deposits.');
  if(plan.members.some(m=>m.id===user.id)) throw Error('You have already joined this plan.');
  plan.members.push({id:user.id,name:user.name,refunded:false});
  plan.ledger.unshift({text:user.name+' joined',amount:plan.amount,time:now});
}
export function refund(plan,id,now=Date.now()) {
  if(status(plan,now)!=='refundable') throw Error('Refunds open when a plan is cancelled or misses its target at the deadline.');
  const member=plan.members.find(m=>m.id===id);
  if(!member || member.refunded) throw Error('There is no deposit available to refund.');
  member.refunded=true;
  plan.ledger.unshift({text:member.name+' received a demo refund',amount:-plan.amount,time:now});
}
export function cancel(plan,id,now=Date.now()) {
  if(plan.ownerId!==id) throw Error('Only the organizer can cancel a plan.');
  if(status(plan,now)!=='open') throw Error('Only an open plan can be cancelled.');
  plan.cancelled=true;
  plan.ledger.unshift({text:'Organizer cancelled the plan',amount:0,time:now});
}
export function release(plan,id,now=Date.now()) {
  if(plan.ownerId!==id) throw Error('Only the organizer can collect the funds.');
  if(status(plan,now)!=='funded' || plan.released) throw Error('Funds are not available to collect.');
  plan.released=true;
  plan.ledger.unshift({text:'Demo funds collected by organizer',amount:-plan.amount*plan.target,time:now});
}
