import { createPublicClient, http, encodeAbiParameters } from 'viem';
import { bsc } from 'viem/chains';
const client = createPublicClient({ chain: bsc, transport: http('https://bsc-dataseed.bnbchain.org') });
const head = await client.getBlockNumber();
const prev = await client.getBlock({ blockNumber: head - 1n });
console.log('head', head, 'prevhash', prev.hash);
const tokens = {
  'P-pancake-v3-SwapRouter': '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
  'P-NPM': '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
  'P-SmartRouter': '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
  'U-SwapRouter02': '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2',
  'U-NPM': '0x7b8a01b39d58278b5de7e48c8449c9f4f5170613',
};
for (const [label, to] of Object.entries(tokens)) {
  const data = '0x1f0464d1' + encodeAbiParameters([{type:'bytes32'},{type:'bytes[]'}], [prev.hash, []]).slice(2);
  try {
    const res = await client.call({ to, data });
    console.log(label, 'multicall(bytes32,[]) OK, data len', (res.data ?? '0x').length);
  } catch (e) {
    console.log(label, 'ERR', String(e.shortMessage ?? e.message).slice(0,120));
  }
}
