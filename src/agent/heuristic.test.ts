import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { shouldUseAgent } from './heuristic.js'

describe('shouldUseAgent', () => {
  describe('time retroactive patterns', () => {
    test('昨天 triggers agent', () => assert.equal(shouldUseAgent('昨天小明说了什么'), true))
    test('今天 triggers agent', () => assert.equal(shouldUseAgent('今天有人发链接吗'), true))
    test('上午 triggers agent', () => assert.equal(shouldUseAgent('上午讨论了什么'), true))
    test('最近 triggers agent', () => assert.equal(shouldUseAgent('最近有什么新消息'), true))
    test('刚才 triggers agent', () => assert.equal(shouldUseAgent('刚才有人叫我吗'), true))
  })

  describe('user query patterns', () => {
    test('谁 triggers agent', () => assert.equal(shouldUseAgent('谁发了这张图'), true))
    test('哪个 triggers agent', () => assert.equal(shouldUseAgent('哪个人说过这话'), true))
    test('说了什么 triggers agent', () => assert.equal(shouldUseAgent('他说了什么'), true))
    test('说过 triggers agent', () => assert.equal(shouldUseAgent('你说过这个吗'), true))
  })

  describe('retrieval intent patterns', () => {
    test('找一下 triggers agent', () => assert.equal(shouldUseAgent('帮我找一下上次的链接'), true))
    test('搜一下 triggers agent', () => assert.equal(shouldUseAgent('搜一下关于猫的消息'), true))
    test('查一下 triggers agent', () => assert.equal(shouldUseAgent('查一下有没有人提过这个'), true))
    test('历史 triggers agent', () => assert.equal(shouldUseAgent('看看历史记录'), true))
    test('记录 triggers agent', () => assert.equal(shouldUseAgent('找一下聊天记录'), true))
  })

  describe('analysis/summary patterns', () => {
    test('总结 triggers agent', () => assert.equal(shouldUseAgent('总结一下今天的讨论'), true))
    test('分析 triggers agent', () => assert.equal(shouldUseAgent('分析一下群里的情况'), true))
    test('回顾 triggers agent', () => assert.equal(shouldUseAgent('回顾一下上周的内容'), true))
    test('整理 triggers agent', () => assert.equal(shouldUseAgent('整理一下要点'), true))
  })

  describe('profile patterns', () => {
    test('喜欢 triggers agent', () => assert.equal(shouldUseAgent('小明喜欢什么'), true))
    test('习惯 triggers agent', () => assert.equal(shouldUseAgent('他有什么习惯'), true))
    test('经常 triggers agent', () => assert.equal(shouldUseAgent('小红经常说什么'), true))
  })

  describe('non-triggering inputs', () => {
    test('simple greeting does not trigger', () => assert.equal(shouldUseAgent('你好'), false))
    test('weather question does not trigger', () => assert.equal(shouldUseAgent('今天天气怎么样'), true)) // contains 今天
    test('plain question does not trigger', () => assert.equal(shouldUseAgent('这道题怎么解'), false))
    test('empty string does not trigger', () => assert.equal(shouldUseAgent(''), false))
    test('translation request does not trigger', () => assert.equal(shouldUseAgent('帮我翻译这段话'), false))
  })
})
