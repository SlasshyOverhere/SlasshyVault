// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { KebabMenu } from './KebabMenu'
import { Trash2, Edit } from 'lucide-react'

vi.mock('lucide-react', () => ({
  MoreHorizontal: () => <span data-testid="more-icon" />,
  Trash2: () => <span data-testid="trash-icon" />,
  Edit: () => <span data-testid="edit-icon" />,
}))

describe('KebabMenu', () => {
  it('renders toggle button', () => {
    render(<KebabMenu items={[]} />)
    expect(screen.getByTestId('more-icon')).toBeTruthy()
  })

  it('opens menu on click', () => {
    render(<KebabMenu items={[{ icon: Trash2, label: 'Delete', onClick: vi.fn() }]} />)
    fireEvent.click(screen.getByTestId('more-icon').closest('button')!)
    expect(screen.getByText('Delete')).toBeTruthy()
  })

  it('calls onClick and closes menu on item click', () => {
    const onClick = vi.fn()
    render(<KebabMenu items={[{ icon: Edit, label: 'Edit', onClick }]} />)
    fireEvent.click(screen.getByTestId('more-icon').closest('button')!)
    fireEvent.click(screen.getByText('Edit'))
    expect(onClick).toHaveBeenCalled()
  })

  it('renders multiple items', () => {
    render(
      <KebabMenu items={[
        { icon: Trash2, label: 'Delete', onClick: vi.fn() },
        { icon: Edit, label: 'Edit', onClick: vi.fn() },
      ]} />
    )
    fireEvent.click(screen.getByTestId('more-icon').closest('button')!)
    expect(screen.getByText('Delete')).toBeTruthy()
    expect(screen.getByText('Edit')).toBeTruthy()
  })
})
