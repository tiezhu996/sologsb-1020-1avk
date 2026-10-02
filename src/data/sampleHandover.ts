import type { ScanReturnPackage } from '../types';

/**
 * 扫描组示例回传包（包中只有扫描件编号、页数、文件指纹；ref 为扫描组抄写的原编号，仅作线索）。
 * 覆盖对账场景：
 * - SM-1006 合并记录指纹不一致（受影响的合并记录）
 * - SM-1008 页数不一致（对应 a-008 ↔ b-008 匹配仍在队列）
 * - SM-1002 页数一致、指纹一致，但回传仍写本机已废弃的旧编号（按稳定编号挂回）
 * - SM-2099 包内有、本机无登记（无主扫描件，待手工绑定）
 * - SM-1018 已登记送扫但本批缺失（自动标记待补，原结论保留）
 */
export const sampleReturnPackage: ScanReturnPackage = {
  batchId: 'SCAN-2026-09-30-A',
  scannedAt: '2026-09-30T18:00:00+08:00',
  entries: [
    {
      scanId: 'SM-1006',
      pages: 35,
      fingerprint: 'sha256:8c2f60d1e9a447bc7024f1d8a6e5b392',
      ref: 'MANU-LSA-98'
    },
    {
      scanId: 'SM-1008',
      pages: 41,
      fingerprint: 'sha256:4d910abf772b6e0ac3f15e892d0b4677',
      ref: 'MANU-HYL-13'
    },
    {
      scanId: 'SM-1002',
      pages: 18,
      fingerprint: 'sha256:9f2c41a7e0b34d8c6f19a5d2e7c840b1',
      ref: 'MS-WDH-17'
    },
    {
      scanId: 'SM-2099',
      pages: 12,
      fingerprint: 'sha256:1e7a33bc95f04d2e8d6c1f4a9b08e277',
      ref: 'OH-UNKNOWN-999'
    }
  ]
};

export const sampleReturnJson = JSON.stringify(sampleReturnPackage, null, 2);
