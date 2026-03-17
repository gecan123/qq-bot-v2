const HEURISTIC_PATTERNS: RegExp[] = [
  // 时间回溯
  /昨天|今天|上午|下午|晚上|之前|前天|上次|最近|刚才/,
  // 用户查询
  /谁|哪个|哪位|说了什么|说过|说过啥/,
  // 检索意图
  /记录|历史|找一下|搜一下|查一下|有没有|还有吗/,
  // 分析摘要
  /总结|汇报|分析|概括|整理|回顾/,
  // 画像相关
  /喜欢|习惯|性格|特点|经常|总是|从不/,
]

export function shouldUseAgent(text: string): boolean {
  return HEURISTIC_PATTERNS.some((p) => p.test(text))
}
