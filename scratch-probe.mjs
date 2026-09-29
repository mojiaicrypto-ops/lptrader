import { createPublicClient, http, encodeAbiParameters, decodeAbiParameters, toFunctionSelector } from 'viem';
import { bsc } from 'viem/chains';
const client = createPublicClient({ chain: bsc, transport: http('https://bsc-dataseed.bnbchain.org') });
const targets = {
  'pancake-v3-SwapRouter 0x1b81d678': '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
  'uniswap-SwapRouter02 0xb971ef87': '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2',
  'pancake-NPM 0x46a15b0b': '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
  'uniswap-NPM 0x7b8a01b3': '0x7B8A01B39D58278b5DE7e48c8449c9f4F5170613',
  'pancake-SmartRouter 0x13f4ea83': '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
};
const selectors = {
  'multicall(bytes32,bytes[])': '0x1f0464d1',
  'multicall(uint256,bytes[])': '0x5ae401dc',
  'multicall(bytes[])': '0xac9650d8',
  'exactInputSingle': '0x414bf389',
  'deadline()': toFunctionSelector('deadline()'),
};
for (const [label, to] of Object.entries(targets)) {
  const out = [];
  for (const [name, sel] of Object.entries(selectors)) {
    try {
      const data = sel + encodeAbiParameters([{type:'bytes32'},{type:'bytes[]'}], [('0x'+'11'.repeat(32)), []]).slice(2) ;
      let res;
      if (name === 'multicall(bytes32,bytes[])') res = await client.call({to, data});
      else res = await client.call({to, data: sel});
      out.push(`${name} -> ok len=${(res.data??'0x').length}`);
    } catch (e) {
      out.push(`${name} -> ERR ${String(e.shortMessage ?? e.message).slice(0,90)}`);
    }
  }
  console.log(label);
  for (const o of out) console.log('   ', o);
}
