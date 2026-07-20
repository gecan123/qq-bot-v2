import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { HomePage } from './index.js'

describe('HomePage', () => {
  test('renders the WebAdmin heading', () => {
    render(<HomePage />)

    expect(screen.getByRole('heading', { name: 'QQ Bot WebAdmin' })).toBeTruthy()
  })
})
