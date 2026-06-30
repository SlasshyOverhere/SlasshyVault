import { defineConfig } from 'vitepress'

export default defineConfig({
  base: '/SlasshyVault/',
  title: 'SlasshyVault',
  description: 'Your media library, powered by your Google Drive. Local-first, privacy-first, open source.',
  themeConfig: {
    logo: false,
    siteTitle: 'SlasshyVault',
    nav: [
      { text: 'Home', link: '/SlasshyVault/' },
      { text: 'Guide', link: '/SlasshyVault/guide/getting-started' },
      { text: 'GitHub', link: 'https://github.com/SlasshyOverhere/SlasshyVault' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Quick Start', link: '/SlasshyVault/guide/getting-started' },
            { text: 'Architecture', link: '/SlasshyVault/guide/architecture' },
            { text: 'Configuration', link: '/SlasshyVault/guide/configuration' },
            { text: 'API Keys', link: '/SlasshyVault/guide/api-keys' },
            { text: 'Watch Together', link: '/SlasshyVault/guide/watch-together' },
            { text: 'Self-Hosting', link: '/SlasshyVault/guide/self-hosting' },
          ],
        },
        {
          text: 'Info',
          items: [
            { text: 'FAQ', link: '/SlasshyVault/guide/faq' },
          ],
        },
      ],
      '/legal/': [
        {
          text: 'Legal',
          items: [
            { text: 'Terms of Service', link: '/SlasshyVault/legal/terms' },
            { text: 'Privacy Policy', link: '/SlasshyVault/legal/privacy' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/SlasshyOverhere/SlasshyVault' },
    ],
    footer: {
      message: 'MIT License · Open Source',
      copyright: 'SlasshyVault',
    },
    search: { provider: 'local' },
  },
  srcDir: '.',
  cleanUrls: true,
  lastUpdated: true,
})
