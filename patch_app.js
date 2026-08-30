const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

code = code.replace(
  "import { useGasCongestionSync } from './utils/congestionSync';",
  "import { useGasCongestionSync } from './utils/congestionSync';\nimport { useAnnouncementSync } from './utils/announcementSync';"
);

const announcementHandler = `
  const handleAnnouncementsSyncUpdate = useCallback((updated: Announcement[]) => {
    setAppData((prev) => ({
      ...prev,
      announcements: updated,
    }));
  }, []);

  useAnnouncementSync(
    appData.gasAnnouncementUrl,
    appData.announcements,
    handleAnnouncementsSyncUpdate,
    30
  );
`;

code = code.replace(
  "  // Hook for automatic GAS synchronization (polls every 15 seconds)",
  announcementHandler + "\n  // Hook for automatic GAS synchronization (polls every 15 seconds)"
);

fs.writeFileSync('src/App.tsx', code);
