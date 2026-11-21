// Reconstruct a strong, pre-release publication checkpoint in a disposable fixture.
const fs = require('node:fs/promises');
const path = require('node:path');
const {createArtifactAnchor,stageNamespace} = require('../../dist/core/staged-delivery');

async function preparePublishedCheckpoint(dir, root, stage, jobIds) {
  const stateFile=path.join(dir,'state','engine.json');
  const state=JSON.parse(await fs.readFile(stateFile,'utf8'));
  jobIds ??= state.jobs.map(job=>job.id);
  for (const id of jobIds) {
    const job=state.jobs.find(item=>item.id===id),record=state.recovery[id],delivery=record.delivery;
    const namespace=path.join(stage,delivery.namespace),main=path.join(namespace,delivery.name);
    const bytes=await fs.readFile(job.destination);
    await fs.writeFile(main,bytes,{flag:'wx',mode:0o600});
    const stageHandle=await fs.open(main,'r+');
    try { delivery.owned=await createArtifactAnchor(namespace,delivery.name,stageHandle); } finally { await stageHandle.close(); }
    await stageNamespace(root,delivery.namespace);
    const partial=path.join(root,record.partial); await fs.link(job.destination,partial);
    const destinationHandle=await fs.open(partial,'r+');
    try { record.owned=await createArtifactAnchor(root,record.partial,destinationHandle,delivery.namespace); } finally { await destinationHandle.close(); }
    delete delivery.stageAnchorRelease; delete delivery.destinationAnchorRelease; delete delivery.retiredDestinations;
    delivery.phase='published'; record.finalization.phase='published'; job.status='interrupted'; record.intent='run';
  }
  await fs.writeFile(stateFile,JSON.stringify(state));
}
module.exports={preparePublishedCheckpoint};
