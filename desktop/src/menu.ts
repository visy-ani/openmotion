import type { MenuItemConstructorOptions } from 'electron';
import type { DesktopMenuAction, DesktopPlatform } from '../../shared/platform-host.ts';

export const DOCS_URL = 'https://github.com/nexu-io/openmotion/tree/main/docs';
export const RELEASES_URL = 'https://github.com/nexu-io/openmotion/releases';
export const REPORT_ISSUE_URL = 'https://github.com/nexu-io/openmotion/issues/new/choose';

export function buildDesktopMenuTemplate(options: {
  platform: DesktopPlatform;
  appVersion: string;
  onAction: (action: DesktopMenuAction) => void;
  onOpenUrl: (url: string) => void;
  onOpenLogsFolder?: () => void;
  onMinimizeWindow?: () => void;
  onHideApp?: () => void;
  onRequestQuit?: () => void;
}): MenuItemConstructorOptions[] {
  const {
    platform,
    appVersion,
    onAction,
    onOpenUrl,
    onOpenLogsFolder,
    onMinimizeWindow,
    onHideApp,
    onRequestQuit,
  } = options;
  const isMac = platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: 'OpenMotion',
      submenu: [
        {
          label: `About OpenMotion (${appVersion})`,
          click: () => onAction('open-about'),
        },
        {
          label: 'Check for Updates…',
          click: () => onAction('check-updates'),
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => onAction('open-settings'),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        {
          label: 'Hide OpenMotion',
          accelerator: 'CmdOrCtrl+M',
          click: () => onHideApp?.(),
        },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Quit OpenMotion',
          accelerator: 'CmdOrCtrl+Q',
          click: () => onRequestQuit?.(),
        },
      ],
    });
  }

  template.push({
    label: 'File',
    submenu: [
      {
        label: 'New Project',
        accelerator: 'CmdOrCtrl+N',
        click: () => onAction('new-project'),
      },
      ...(!isMac
        ? [
            { type: 'separator' } as MenuItemConstructorOptions,
            {
              label: 'Settings…',
              accelerator: 'CmdOrCtrl+,',
              click: () => onAction('open-settings'),
            } as MenuItemConstructorOptions,
            { type: 'separator' } as MenuItemConstructorOptions,
            {
              label: 'Quit OpenMotion',
              accelerator: 'CmdOrCtrl+Q',
              click: () => onRequestQuit?.(),
            } as MenuItemConstructorOptions,
          ]
        : []),
    ],
  });

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? [
            { role: 'pasteAndMatchStyle' } as MenuItemConstructorOptions,
            { role: 'delete' } as MenuItemConstructorOptions,
            { role: 'selectAll' } as MenuItemConstructorOptions,
          ]
        : [
            { role: 'delete' } as MenuItemConstructorOptions,
            { type: 'separator' } as MenuItemConstructorOptions,
            { role: 'selectAll' } as MenuItemConstructorOptions,
          ]),
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      {
        label: 'Reload Workspace',
        accelerator: 'CmdOrCtrl+R',
        click: () => onAction('reload-app'),
      },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  template.push({
    label: 'Agents & MCP',
    submenu: [
      {
        label: 'Connect Agent via MCP…',
        click: () => onAction('open-mcp-connect'),
      },
      {
        label: 'Agent Runtimes, Bridges & Batch…',
        click: () => onAction('open-agent-runtimes'),
      },
    ],
  });

  template.push({
    role: 'windowMenu',
    submenu: isMac
      ? [
          {
            label: 'Minimize Window',
            accelerator: 'CmdOrCtrl+W',
            click: () => onMinimizeWindow?.(),
          },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'front' },
        ]
      : [
          {
            label: 'Minimize Window',
            accelerator: 'CmdOrCtrl+W',
            click: () => onMinimizeWindow?.(),
          },
          {
            label: 'Hide OpenMotion',
            accelerator: 'CmdOrCtrl+M',
            click: () => onHideApp?.(),
          },
        ],
  });

  template.push({
    role: 'help',
    submenu: [
      {
        label: 'Help Center',
        click: () => onAction('open-help'),
      },
      {
        label: 'Documentation',
        click: () => onOpenUrl(DOCS_URL),
      },
      {
        label: "What's New / Releases",
        click: () => onOpenUrl(RELEASES_URL),
      },
      { type: 'separator' },
      {
        label: 'Export Diagnostic Logs…',
        click: () => onAction('export-logs'),
      },
      ...(onOpenLogsFolder
        ? [
            {
              label: 'Open Logs Folder',
              click: () => onOpenLogsFolder(),
            } as MenuItemConstructorOptions,
          ]
        : []),
      {
        label: 'Report an Issue…',
        click: () => onOpenUrl(REPORT_ISSUE_URL),
      },
      { type: 'separator' },
      {
        label: 'Join Community (Feishu)',
        click: () => onAction('join-community-feishu'),
      },
      {
        label: 'Join Community (Discord)',
        click: () => onAction('join-community-discord'),
      },
      ...(!isMac
        ? [
            { type: 'separator' } as MenuItemConstructorOptions,
            {
              label: 'Check for Updates…',
              click: () => onAction('check-updates'),
            } as MenuItemConstructorOptions,
            {
              label: `About OpenMotion (${appVersion})`,
              click: () => onAction('open-about'),
            } as MenuItemConstructorOptions,
          ]
        : []),
    ],
  });

  return template;
}
