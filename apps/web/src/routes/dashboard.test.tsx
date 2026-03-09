import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({
  Component: (() => null) as React.ComponentType,
  beforeLoad: undefined as ((ctx?: unknown) => unknown) | undefined,
  redirect: vi.fn((opts: unknown) => opts),
}))

const mockNavigate = vi.fn()
const mockSignOut = vi.fn().mockResolvedValue({})

vi.mock('@tanstack/react-router', () => ({
  createFileRoute:
    () => (config: { component: React.ComponentType; beforeLoad?: (ctx?: unknown) => unknown }) => {
      captured.Component = config.component
      captured.beforeLoad = config.beforeLoad
      return { component: config.component, beforeLoad: config.beforeLoad }
    },
  redirect: captured.redirect,
  useNavigate: () => mockNavigate,
}))

vi.mock('@repo/ui', async () => await import('@/test/__mocks__/repoUi'))

vi.mock('@/lib/authClient', () => ({
  useSession: vi.fn(() => ({
    data: { user: { name: 'Ada Lovelace', image: null } },
  })),
  signOut: (...args: unknown[]) => mockSignOut(...args),
}))

vi.mock('@/lib/routeGuards', () => ({
  requireAuth: vi.fn(),
}))

// Import after mocks to trigger createFileRoute and capture the component
import './dashboard'
import { useSession } from '@/lib/authClient'
import { requireAuth } from '@/lib/routeGuards'

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSignOut.mockResolvedValue({})
    vi.mocked(useSession).mockReturnValue({
      data: { user: { name: 'Ada Lovelace', image: null } },
    } as ReturnType<typeof useSession>)
  })

  it('should render the Roxabi Dashboard heading', () => {
    // Arrange
    const DashboardPage = captured.Component

    // Act
    render(<DashboardPage />)

    // Assert
    expect(screen.getByText('Roxabi Dashboard')).toBeInTheDocument()
  })

  it('should render all 3 placeholder cards', () => {
    // Arrange
    const DashboardPage = captured.Component

    // Act
    render(<DashboardPage />)

    // Assert
    expect(screen.getByText('Issues')).toBeInTheDocument()
    expect(screen.getByText('Pull Requests')).toBeInTheDocument()
    expect(screen.getByText('Deployments')).toBeInTheDocument()
  })

  it('should show user name when session is active', () => {
    // Arrange
    vi.mocked(useSession).mockReturnValue({
      data: { user: { name: 'Ada Lovelace', image: null } },
    } as ReturnType<typeof useSession>)
    const DashboardPage = captured.Component

    // Act
    render(<DashboardPage />)

    // Assert
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
  })

  it('should show user avatar when session has an image', () => {
    // Arrange
    vi.mocked(useSession).mockReturnValue({
      data: { user: { name: 'Ada Lovelace', image: 'https://example.com/avatar.png' } },
    } as ReturnType<typeof useSession>)
    const DashboardPage = captured.Component

    // Act
    render(<DashboardPage />)

    // Assert
    const avatar = screen.getByRole('img', { name: /ada lovelace's avatar/i })
    expect(avatar).toHaveAttribute('src', 'https://example.com/avatar.png')
  })

  it('should not show user info when session is null', () => {
    // Arrange
    vi.mocked(useSession).mockReturnValue({
      data: null,
    } as ReturnType<typeof useSession>)
    const DashboardPage = captured.Component

    // Act
    render(<DashboardPage />)

    // Assert
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument()
    expect(screen.queryByText('Sign out')).not.toBeInTheDocument()
  })

  it('should call requireAuth as beforeLoad to redirect unauthenticated users', () => {
    // The beforeLoad is wired to requireAuth — confirm it was passed through
    expect(captured.beforeLoad).toBe(requireAuth)
  })

  it('should call signOut and navigate to /login when sign-out button is clicked', async () => {
    // Arrange
    const user = userEvent.setup()
    const DashboardPage = captured.Component
    render(<DashboardPage />)

    // Act
    const signOutButton = screen.getByText('Sign out')
    await user.click(signOutButton)

    // Assert
    expect(mockSignOut).toHaveBeenCalled()
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' })
  })
})
