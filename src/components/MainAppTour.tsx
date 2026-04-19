import { GuidedTour, TourStep } from "@/components/GuidedTour"

interface MainAppTourProps {
  isActive: boolean
  onComplete: () => void
  onSkip: () => void
  setView: (view: string) => void
}

export function MainAppTour({ isActive, onComplete, onSkip, setView }: MainAppTourProps) {
  const allSteps: TourStep[] = [
    {
      id: 'sidebar-intro',
      target: '[data-tour="sidebar"]',
      title: 'Your Navigation Hub',
      description: 'This sidebar is your main navigation. It gives you quick access to Home, Google Drive, History, and the main app controls.',
      position: 'right',
      highlight: false,
    },
    {
      id: 'nav-home',
      target: '[data-tour="nav-home"]',
      title: 'Home - Your Dashboard',
      description: 'The Home screen shows your continue watching, library stats, and a quick search across all your media. It\'s your starting point.',
      position: 'right',
      action: () => setView('home'),
    },
    {
      id: 'nav-cloud',
      target: '[data-tour="nav-cloud"]',
      title: 'Google Drive',
      description: 'Access your cloud media from Google Drive! Connect your account in Settings, add folders, and stream directly without downloading.',
      position: 'right',
      action: () => setView('cloud'),
    },
    {
      id: 'nav-history',
      target: '[data-tour="nav-history"]',
      title: 'Watch History',
      description: 'Track what you\'ve watched! Resume from where you left off anytime.',
      position: 'right',
      action: () => setView('history'),
    },
    {
      id: 'scan-library',
      target: '[data-tour="scan-library-btn"]',
      title: 'Update Library',
      description: 'Click this to scan your media folders for new content. StreamVault will automatically fetch posters, descriptions, and organize everything.',
      position: 'right',
    },
    {
      id: 'settings-btn',
      target: '[data-tour="settings-btn"]',
      title: 'Settings',
      description: 'Configure your media folders, TMDB API key, Google Drive, player settings, and more. This is where you set up StreamVault to work with your library.',
      position: 'right',
    },
    {
      id: 'cloud-view-tip',
      target: '[data-tour="nav-cloud"]',
      title: 'Movies and TV in One Place',
      description: 'Inside Google Drive, use the floating controls to switch between Movies and TV Shows, search quickly, and change the card layout.',
      position: 'right',
      action: () => setView('cloud'),
    },
    {
      id: 'fix-match-info',
      target: '[data-tour="nav-cloud"]',
      title: 'Wrong Poster or Title?',
      description: 'If a movie or show has the wrong artwork or metadata, open its menu and use "Fix Match" to pick the correct TMDB result.',
      position: 'right',
      action: () => setView('cloud'),
    },
    {
      id: 'refresh-info',
      target: '[data-tour="scan-library-btn"]',
      title: 'Refresh Everything',
      description: 'To refresh all metadata, click "Update Library". This rescans your folders and updates any missing or outdated posters and information.',
      position: 'right',
    },
    {
      id: 'tour-complete',
      target: '[data-tour="nav-home"]',
      title: 'You\'re Ready!',
      description: 'That\'s the basics! Now head to Settings to add your TMDB API key and media folders. Enjoy your personalized media center!',
      position: 'right',
      action: () => setView('home'),
    },
  ]

  return (
    <GuidedTour
      steps={allSteps}
      isActive={isActive}
      onComplete={onComplete}
      onSkip={onSkip}
    />
  )
}
