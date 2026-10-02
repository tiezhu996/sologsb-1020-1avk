/**
 * 扫描组 2026-09-30 批次回传示例包。
 * 包内只有扫描件稳定编号、页数与文件指纹，不含任何业务字段。
 * - SCAN-MS-0017 编号本机已改（MS-WDH-17 → MS-WDH-2017-17），仍按稳定编号挂回
 * - SCAN-MS-0034 页数不一致（本机 34 / 回传 35），且落在已合并记录 m-006 上
 * - SCAN-MANU-0033 页数（33→34）与指纹均不一致，验证兄弟单一并闭环
 * - SCAN-MANU-0041 指纹不一致（扫描时本就缺第 12 页）
 * - SCAN-MS-0042 本批未回传 → 缺件待补，原结论保留
 * - SCAN-X-9999 无登记 → 无主扫描件
 * 重复导入同一 batchId 时沿用已有处理结果，不重复立单。
 */
export const sampleScanPacket = `{
  "batchId": "BATCH-2026-09-30-01",
  "entries": [
    { "scanId": "SCAN-MS-0017",    "pages": 18, "fingerprint": "sha256:7c41e0a2d9b84f31" },
    { "scanId": "SCAN-MS-0034",    "pages": 35, "fingerprint": "sha256:3f92ab7106dc5e2c" },
    { "scanId": "SCAN-MANU-0033",  "pages": 34, "fingerprint": "sha256:62f9e517070ac83b" },
    { "scanId": "SCAN-MANU-0041",  "pages": 41, "fingerprint": "sha256:0f1e2d3c4b5a6978" },
    { "scanId": "SCAN-X-9999",     "pages": 9,  "fingerprint": "sha256:deadbeef00000000" }
  ]
}`;

/** 补传包：SCAN-MS-0042 重新扫回，自动关闭缺件待补单 */
export const sampleRescanPacket = `{
  "batchId": "BATCH-2026-10-02-RESCAN",
  "type": "partial",
  "entries": [
    { "scanId": "SCAN-MS-0042", "pages": 42, "fingerprint": "sha256:8a0d6f13ce57b904" }
  ]
}`;
