import { describe, expect, it } from 'vitest'
import {
  VOICE_SUMMARY_CLOSE, VOICE_SUMMARY_OPEN,
  spokenReplyText, visibleReplyText, voiceSummary,
} from '../../src/client/voice-summary.ts'

describe('voice summary markers', () => {
  it('extracts only the marked takeaway for speech', () => {
    const reply = `${VOICE_SUMMARY_OPEN}已修复登录问题${VOICE_SUMMARY_CLOSE}\n\n## 详情\n\n- 修改了 3 个文件\n- 跑了测试`
    expect(voiceSummary(reply)).toBe('已修复登录问题')
    expect(spokenReplyText(reply)).toBe('已修复登录问题')
  })

  it('speaks the whole reply when no marker is present', () => {
    const reply = '简短回复，直接读出来就好'
    expect(voiceSummary(reply)).toBeUndefined()
    expect(spokenReplyText(reply)).toBe(reply)
  })

  it('falls back to the whole reply for an empty or malformed marker, without reading the control symbols', () => {
    expect(spokenReplyText(`${VOICE_SUMMARY_OPEN}   ${VOICE_SUMMARY_CLOSE}`)).toBe('')
    expect(spokenReplyText(`${VOICE_SUMMARY_OPEN}只有开头`)).toBe('只有开头')
    expect(spokenReplyText(`只有结尾${VOICE_SUMMARY_CLOSE}`)).toBe('只有结尾')
  })

  it('uses the first takeaway and tolerates a multiline one', () => {
    expect(voiceSummary('[voice]第一句[/voice] 正文 [voice]第二句[/voice]')).toBe('第一句')
    expect(voiceSummary('[voice]\n  核心结论，跨行  \n[/voice]')).toBe('核心结论，跨行')
  })

  it('keeps the full visible reply but removes a well-formed marker pair', () => {
    const reply = '[voice]已修复登录问题[/voice]\n\n## 详情\n\n- 修改了 3 个文件'
    expect(visibleReplyText(reply)).toBe('已修复登录问题\n\n## 详情\n\n- 修改了 3 个文件')
  })

  it('leaves malformed markers visible and collapses marker-only blank lines', () => {
    expect(visibleReplyText('[voice]只有开头')).toBe('[voice]只有开头')
    expect(visibleReplyText('[voice]\n总结\n[/voice]\n\n\n正文')).toBe('总结\n\n正文')
    expect(visibleReplyText('  [voice]总结[/voice]  ')).toBe('总结')
  })
})
