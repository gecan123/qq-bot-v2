import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { afterEach, describe, test } from 'node:test'
import { loadPrompt } from './prompt-loader.js'

const CONFIG_PATH = 'agent-config.json'

async function loadProfilesModule() {
  return import(`./agent-profiles.js?ts=${Date.now()}`)
}

describe('agent profiles', () => {
  afterEach(() => {
    fs.rmSync(CONFIG_PATH, { force: true })
  })

  test('default profile exposes a richer group-chat persona baseline', async () => {
    const { getAgentProfile } = await loadProfilesModule()
    const profile = getAgentProfile(123)
    const expectedPersona = loadPrompt('./prompts/characters/default.md')

    assert.equal(profile.persona, expectedPersona)
    assert.match(profile.persona, /你是群里的常驻 AI 搭子/)
    assert.match(profile.persona, /你的整体气质：/)
    assert.match(profile.persona, /你的说话习惯：/)
    assert.match(profile.persona, /你的连续性：/)
    assert.match(profile.persona, /群聊里的最低规则：/)
  })

  test('group config can override the default persona baseline', async () => {
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        default: {},
        groups: {
          '123': {
            persona: '你在这个群里偏克制，只在必要时插话。',
          },
        },
      }),
    )

    const { getAgentProfile } = await loadProfilesModule()
    const profile = getAgentProfile(123)

    assert.equal(profile.persona, '你在这个群里偏克制，只在必要时插话。')
  })
})
