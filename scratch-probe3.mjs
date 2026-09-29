import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';
const client = createPublicClient({ chain: bsc, transport: http('https://bsc-dataseed.bnbchain.org') });
const P_ROUTER='0x1b81D678ffb9C0263b24A97847620C99d213eB14';
const U_ROUTER='0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2';
const ctx = [
  ['WETH9()','0x4aa4a4fc'],
  ['factory()','0xc45a0155'],
  ['positionManager()','0x791b98bc'],
  ['deployer()','0x2d06177a'],
  ['multicall(bytes[])','0xac9650d8'],
];
for (const router of [P_ROUTER, U_ROUTER]) {
  console.log('==', router);
  for (const [name, sel] of ctx) {
    try { const r = await client.call({to: router, data: sel}); console.log('  ', name, 'OK', (r.data??'0x').slice(0,50)); }
    catch(e){ console.log('  ', name, 'ERR', String(e.shortMessage??e.message).slice(0,70)); }
  }
}
