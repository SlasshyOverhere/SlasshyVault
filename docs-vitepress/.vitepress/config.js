import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'SlasshyVault',
  description: 'Your media library, powered by your Google Drive. Local-first, privacy-first, open source.',
  themeConfig: {
    logo: false,
    siteTitle: 'SlasshyVault',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'GitHub', link: 'https://github.com/SlasshyOverhere/SlasshyVault' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Quick Start', link: '/guide/getting-started' },
            { text: 'Architecture', link: '/guide/architecture' },
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'API Keys', link: '/guide/api-keys' },
            { text: 'Watch Together', link: '/guide/watch-together' },
            { text: 'Self-Hosting', link: '/guide/self-hosting' },
          ],
        },
        {
          text: 'Info',
          items: [
            { text: 'FAQ', link: '/guide/faq' },
          ],
        },
      ],
      '/legal/': [
        {
          text: 'Legal',
          items: [
            { text: 'Terms of Service', link: '/legal/terms' },
            { text: 'Privacy Policy', link: '/legal/privacy' },
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
