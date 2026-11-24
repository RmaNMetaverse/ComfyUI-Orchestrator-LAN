const config = {
  title: 'ComfyFleet docs',
  tagline: 'Run a ComfyUI fleet from one browser tab',
  url: 'https://rmanmetaverse.github.io',
  baseUrl: '/ComfyUI-Orchestrator-LAN/',
  organizationName: 'RmaNMetaverse',
  projectName: 'ComfyUI-Orchestrator-LAN',
  trailingSlash: true,
  onBrokenLinks: 'throw',
  presets: [
    ['classic', {
      docs: {
        routeBasePath: '/',
        sidebarPath: './sidebars.js',
        docItemComponent: '@theme/ApiItem',
      },
      blog: false,
      theme: { customCss: './src/css/custom.css' },
    }],
  ],
  plugins: [[
    'docusaurus-plugin-openapi-docs',
    {
      id: 'api',
      docsPluginId: 'classic',
      config: {
        comfyfleet: {
          specPath: 'static/openapi.yaml',
          outputDir: 'docs/api',
          sidebarOptions: { groupPathsBy: 'tag' },
        },
      },
    },
  ]],
  themes: ['docusaurus-theme-openapi-docs'],
  themeConfig: {
    navbar: {
      title: 'ComfyFleet',
      items: [
        { to: '/', label: 'Quickstart', position: 'left' },
        { to: '/troubleshooting/', label: 'Troubleshooting', position: 'left' },
        { href: 'https://github.com/RmaNMetaverse/ComfyUI-Orchestrator-LAN', label: 'GitHub', position: 'right' },
      ],
    },
    footer: { style: 'dark', copyright: 'ComfyFleet documentation' },
  },
};

module.exports = config;
