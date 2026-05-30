'use strict';

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'linksql-playground',
    name: 'LinksQL Playground',
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux', 'win32'],
    },
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'linksql_playground',
      },
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          maintainer: 'LinksQL Maintainers',
          homepage: 'https://github.com/link-foundation/linksql',
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
};
