import { GuidedTour, TourStep } from "@/components/GuidedTour"

interface MainAppTourProps {
  isActive: boolean
  onComplete: () => void
  onSkip: () => void
  setView: (view: string) => void
  showStreamTab?: boolean
}

export function MainAppTour({ isActive, onComplete, onSkip, setView, showStreamTab = false }: MainAppTourProps) {
  const allSteps: TourStep[] = [
    // Sidebar Overview
    {
      id: 'sidebar-intro',
      target: '[data-tour="sidebar"]',
      title: 'Your Navigation Hub',
      description: 'This sidebar is your main navigation. Let me show you what each section does and how to get the most out of StreamVault.',
      position: 'right',
      highlight: false,
    },

    // Home Tab
    {
      id: 'nav-home',
      target: '[data-tour="nav-home"]',
      title: 'Home - Your Dashboard',
      description: 'The Home screen shows your continue watching, library stats, and a quick search across all your media. It\'s your starting point.',
      position: 'right',
      action: () => setView('home'),
    },

    // Local Tab
    {
      id: 'nav-local',
      target: '[data-tour="nav-local"]',
      title: 'Local Library',
      description: 'Browse all your local movies and TV shows here. Use the sub-tabs to switch between Movies and TV Shows. Search, filter, and switch between grid/list views.',
      position: 'right',
      action: () => setView('local'),
    },

    // Google Drive Tab
    {
      id: 'nav-cloud',
      target: '[data-tour="nav-cloud"]',
      title: 'Google Drive',
      description: 'Access your cloud media from Google Drive! Connect your account in Settings, add folders, and stream directly without downloading.',
      position: 'right',
      action: () => setView('cloud'),
    },

    // Discover Tab
    {
      id: 'nav-stream',
      target: '[data-tour="nav-stream"]',
      title: 'Discover & Stream',
      description: 'Search for any movie or TV show online. Stream content directly or find where to watch. Powered by TMDB and streaming providers.',
      position: 'right',
      action: () => setView('stream'),
    },

    // History Tab
    {
      id: 'nav-history',
      target: '[data-tour="nav-history"]',
      title: 'Watch History',
      description: 'Track what you\'ve watched! Switch between Local (your library) and Streaming history. Resume from where you left off anytime.',
      position: 'right',
      action: () => setView('history'),
    },

    // Scan/Update Library Button
    {
      id: 'scan-library',
      target: '[data-tour="scan-library-btn"]',
      title: 'Update Library',
      description: 'Click this to scan your media folders for new content. StreamVault will automatically fetch posters, descriptions, and organize everything.',
      position: 'right',
    },

    // Settings Button
    {
      id: 'settings-btn',
      target: '[data-tour="settings-btn"]',
      title: 'Settings',
      description: 'Configure your media folders, TMDB API key, Google Drive, player settings, and more. This is where you set up StreamVault to work with your library.',
      position: 'right',
    },

    // Context Menu Info (shown on local view)
    {
      id: 'context-menu-info',
      target: '[data-tour="nav-local"]',
      title: 'Right-Click for More Options!',
      description: 'Right-click on any movie or TV show card to access quick actions: Play, Fix Match (correct wrong metadata), Remove from History, or Delete from Drive.',
      position: 'right',
      action: () => setView('local'),
    },

    // Fix Match Explanation
    {
      id: 'fix-match-info',
      target: '[data-tour="nav-local"]',
      title: 'Wrong Poster or Title?',
      description: 'If a movie/show has the wrong artwork or info, right-click and select "Fix Match". You can search TMDB and pick the correct match to update all metadata.',
      position: 'right',
    },

    // Refresh Metadata Explanation
    {
      id: 'refresh-info',
      target: '[data-tour="scan-library-btn"]',
      title: 'Refresh Everything',
      description: 'To refresh all metadata, click "Update Library". This rescans your folders and updates any missing or outdated posters and information.',
      position: 'right',
    },

    // Sub-tabs Tip
    {
      id: 'subtabs-tip',
      target: '[data-tour="nav-local"]',
      title: 'Movies & TV Sub-tabs',
      description: 'When viewing Local or Google Drive, use the floating tabs at the top to switch between Movies and TV Shows quickly!',
      position: 'right',
      action: () => setView('local'),
    },

    // Final Step
    {
      id: 'tour-complete',
      target: '[data-tour="nav-home"]',
      title: 'You\'re Ready! 🎉',
      description: 'That\'s the basics! Now head to Settings to add your TMDB API key and media folders. Enjoy your personalized media center!',
      position: 'right',
      action: () => setView('home'),
    },
  ]

  const tourSteps = allSteps.filter((step) => showStreamTab || step.id !== 'nav-stream')

  return (
    <GuidedTour
      steps={tourSteps}
      isActive={isActive}
      onComplete={onComplete}
      onSkip={onSkip}
    />
  )
}
