/**
 * QuickNode Streams filter (dataset: block_with_receipts, Arc Testnet).
 *
 * Runs on QuickNode for every block and keeps only what Kitty needs:
 *   - every log the GroupTreasury emitted (joins, caps, spends, approvals, pulls, debts)
 *   - the USDC Transfer logs in those same transactions (who actually paid whom)
 * Output rows match what the Arc explorer API returns (logs: hex numbers, transfers: decimal), so
 * the dashboard's existing decoder reads Stream rows and explorer rows the same way.
 * Blocks with nothing of Kitty's return null and are never delivered.
 *
 * The TREASURY placeholder below is replaced with the contract address by scripts/create-stream.mjs.
 * The sandbox has no imports, so this file is plain JS with a single `main`.
 */
var TREASURY = "__TREASURY__".toLowerCase();
var USDC = "0x3600000000000000000000000000000000000000";
var TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function toHex(v) {
  if (typeof v === "number") return "0x" + v.toString(16);
  if (typeof v === "string" && /^0x[0-9a-f]*$/i.test(v)) return v.toLowerCase();
  if (typeof v === "string" && /^\d+$/.test(v)) return "0x" + BigInt(v).toString(16);
  return "0x0";
}

function toDec(v) {
  var h = toHex(v);
  return h === "0x" ? "0" : BigInt(h).toString();
}

function topicAddress(topic) {
  return "0x" + String(topic || "").slice(-40).toLowerCase();
}

function main(stream) {
  var data = stream && stream.data ? stream.data : [];
  var blocks = Array.isArray(data) ? data.flat(2) : [data];
  var logs = [];
  var transfers = [];

  for (var b = 0; b < blocks.length; b++) {
    var block = blocks[b] || {};
    var header = block.block || block;
    var receipts = block.receipts || [];
    for (var r = 0; r < receipts.length; r++) {
      var receiptLogs = receipts[r].logs || [];
      var ours = receiptLogs.some(function (log) {
        return String(log.address).toLowerCase() === TREASURY;
      });
      if (!ours) continue;
      for (var i = 0; i < receiptLogs.length; i++) {
        var log = receiptLogs[i];
        var address = String(log.address).toLowerCase();
        var blockNumber = log.blockNumber || header.number;
        var tx = log.transactionHash || receipts[r].transactionHash;
        if (address === TREASURY) {
          logs.push({
            address: address,
            topics: log.topics,
            data: log.data,
            transactionHash: tx,
            timeStamp: toHex(header.timestamp),
            blockNumber: toHex(blockNumber),
            logIndex: toHex(log.logIndex),
          });
        } else if (address === USDC && log.topics && String(log.topics[0]).toLowerCase() === TRANSFER) {
          transfers.push({
            hash: tx,
            from: topicAddress(log.topics[1]),
            to: topicAddress(log.topics[2]),
            value: toDec(log.data),
            timeStamp: toDec(header.timestamp),
            blockNumber: toDec(blockNumber),
            logIndex: toDec(log.logIndex),
          });
        }
      }
    }
  }

  return logs.length || transfers.length ? { logs: logs, transfers: transfers } : null;
}
