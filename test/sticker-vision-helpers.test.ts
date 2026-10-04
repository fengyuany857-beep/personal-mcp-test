import assert from 'node:assert/strict'
import test from 'node:test'
import { SEMANTIC_STICKER_LIMIT, rankStickerCatalog, shouldDownscaleImage, stableStickerAssetId, stickerDeliveryUrl } from '../src/service'

function asset(id: number, embedding?: number[]) {
  return { id, embedding }
}

test('rankStickerCatalog passes through when below the limit or without a query vector', () => {
  const assets = [asset(1), asset(2), asset(3)]
  assert.deepEqual(rankStickerCatalog(assets, [1, 0], 12), assets)
  assert.deepEqual(rankStickerCatalog(assets, [], 2), assets)
})

test('rankStickerCatalog orders by cosine similarity and fills leftover slots with unvectorized assets', () => {
  const assets = [
    asset(1, [0, 1]),
    asset(2, [1, 0]),
    asset(3),
    asset(4, [0.9, 0.1]),
  ]
  const ranked = rankStickerCatalog(assets, [1, 0], 3)
  assert.deepEqual(ranked.map(item => item.id), [2, 4, 1])
})

test('semantic sticker limit is twelve', () => {
  assert.equal(SEMANTIC_STICKER_LIMIT, 12)
})

test('shouldDownscaleImage gates mime types and small payloads', () => {
  const bigBase64 = 'A'.repeat(220_000)
  const smallBase64 = 'A'.repeat(1_000)
  assert.equal(shouldDownscaleImage('image/jpeg', `data:image/jpeg;base64,${bigBase64}`), true)
  assert.equal(shouldDownscaleImage('image/png', `data:image/png;base64,${bigBase64}`), true)
  assert.equal(shouldDownscaleImage('image/webp', `data:image/webp;base64,${bigBase64}`), true)
  assert.equal(shouldDownscaleImage('image/gif', `data:image/gif;base64,${bigBase64}`), false)
  assert.equal(shouldDownscaleImage('image/svg+xml', `data:image/svg+xml;base64,${bigBase64}`), false)
  assert.equal(shouldDownscaleImage('image/jpeg', `data:image/jpeg;base64,${smallBase64}`), false)
  assert.equal(shouldDownscaleImage('image/jpeg', 'data:image/jpeg;base64,'), false)
})

test('stableStickerAssetId keeps punctuation-colliding filenames globally distinct', () => {
  const hashA = 'a'.repeat(64)
  const hashB = 'b'.repeat(64)
  assert.equal(stableStickerAssetId('bq (6).png', hashA), stableStickerAssetId('bq (6).png', hashA))
  assert.notEqual(stableStickerAssetId('bq (6).png', hashA), stableStickerAssetId('bq [6].png', hashB))
  // 后缀自 rc29 起为 sha1(路径+内容) 联合哈希前缀：中文折叠碰撞免疫，路径/内容任一变化必然分叉
  const expected = require('node:crypto').createHash('sha1').update(`bq (6).png
${hashA}`).digest('hex').slice(0, 16)
  assert.match(stableStickerAssetId('bq (6).png', hashA), new RegExp(`${expected}$`))
})

test('assetId 联合唯一：中文路径同内容不碰撞（UNIQUE 扫描崩溃根因）', () => {
  const sameContent = 'a'.repeat(64)
  // 旧实现：两个中文分组路径折叠后 stem 同为 'sticker'，同内容 hash 相同 → 同 assetId → 每轮扫描 UNIQUE 崩
  const a = stableStickerAssetId('猫猫收藏/笑死.gif', sameContent)
  const b = stableStickerAssetId('日常贴纸/笑死.gif', sameContent)
  assert.notEqual(a, b, '路径不同必然分叉')
  assert.equal(a, stableStickerAssetId('猫猫收藏/笑死.gif', sameContent), '同输入确定性')
  assert.notEqual(stableStickerAssetId('猫猫收藏/笑死.gif', sameContent), stableStickerAssetId('猫猫收藏/笑死.gif', 'b'.repeat(64)), '内容变化即换 id')
  assert.match(a, /^sticker-[0-9a-f]{16}$/, '中文折叠回退 stem 保持合法形态')
})

test('表情包投递 URL：HTTP 回源（OneBot 实现分容器时 file:// 必然失败）', () => {
  assert.equal(stickerDeliveryUrl('http://127.0.0.1:5140', 'sticker-abc123'), 'http://127.0.0.1:5140/hds-interlude/sticker/sticker-abc123')
  assert.equal(stickerDeliveryUrl('http://192.168.1.10:5140/', 'x'), 'http://192.168.1.10:5140/hds-interlude/sticker/x', '尾斜杠归一')
  assert.match(stickerDeliveryUrl('', '猫/笑'), /http:\/\/127\.0\.0\.1:5140\/hds-interlude\/sticker\//, '空基址回退本机默认')
  assert.ok(stickerDeliveryUrl('http://h:1', 'a b').includes(encodeURIComponent('a b')), 'assetId 编码')
})
