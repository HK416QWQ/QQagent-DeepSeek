import { createHash } from 'node:crypto';

// 印象内容摘要：只用于判断“旧内容还在不在”，不落原文。
// ★ 算法冻结：与旧实现 contentDigest 完全一致（sha1 前 16 位）。
//   换算法 = 启用瞬间所有旧摘要同时消失，强制全量重建前缀缓存。
//   golden: digest('说话极简短') === '6235da20240d7a39'
export function contentDigest(content) {
  return createHash('sha1').update(String(content ?? '')).digest('hex').slice(0, 16);
}