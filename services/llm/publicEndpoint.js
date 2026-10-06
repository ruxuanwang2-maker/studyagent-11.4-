const dns = require('node:dns').promises;
const net = require('node:net');

const blockedAddresses = new net.BlockList();
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96],
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
]) blockedAddresses.addSubnet(network, prefix, 'ipv6');

const blockedIpv4Ranges = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].map(([address, prefix]) => {
  const start = address.split('.').reduce((value, part) => (value * 256) + Number(part), 0) >>> 0;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return [start & mask, mask];
});

function isPublicAddress(address) {
  const type = net.isIP(address);
  if (type === 4) {
    const number = address.split('.').reduce((value, part) => (value * 256) + Number(part), 0) >>> 0;
    return !blockedIpv4Ranges.some(([start, mask]) => (number & mask) === start);
  }
  return type === 6 && !blockedAddresses.check(address, 'ipv6');
}

async function assertPublicHttpsEndpoint(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw Object.assign(new Error('模型服务地址必须是有效的 HTTPS URL。'), { code: 'INVALID_MODEL_ENDPOINT', status: 400 }); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) {
    throw Object.assign(new Error('模型发现仅允许无凭据的公网 HTTPS 地址。'), { code: 'INVALID_MODEL_ENDPOINT', status: 400 });
  }
  let addresses;
  try {
    const ipType = net.isIP(url.hostname);
    addresses = ipType ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error('无法解析模型服务地址。'), { code: 'INVALID_MODEL_ENDPOINT', status: 400 });
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw Object.assign(new Error('模型服务地址必须解析到公网 IP。'), { code: 'INVALID_MODEL_ENDPOINT', status: 400 });
  }
  return { url, addresses: addresses.map(({ address }) => address) };
}

module.exports = { assertPublicHttpsEndpoint };
