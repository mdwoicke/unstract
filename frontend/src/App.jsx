import { Button, ConfigProvider, notification, theme } from "antd";
import { BrowserRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { useEffect } from "react";

import { Router } from "./routes/Router.jsx";
import { useAlertStore } from "./store/alert-store.js";
import { useSessionStore } from "./store/session-store.js";
import { GenericLoader } from "./components/generic-loader/GenericLoader";
import PostHogPageviewTracker from "./PostHogPageviewTracker.js";
import { PageTitle } from "./components/widgets/page-title/PageTitle.jsx";
import CustomMarkdown from "./components/helpers/custom-markdown/CustomMarkdown.jsx";
import { useSocketLogsStore } from "./store/socket-logs-store.js";

let GoogleTagManagerHelper;
try {
  GoogleTagManagerHelper =
    require("./plugins/google-tag-manager-helper/GoogleTagManagerHelper.js").GoogleTagManagerHelper;
} catch {
  // The component will remain null of it is not available
}

function App() {
  const [notificationAPI, contextHolder] = notification.useNotification();
  const { darkAlgorithm } = theme;
  const { isLogoutLoading } = useSessionStore();
  const { alertDetails } = useAlertStore();
  const { pushLogMessages } = useSocketLogsStore();

  const btn = (
    <>
      <Button
        type="link"
        size="small"
        onClick={() => notificationAPI.destroy(alertDetails?.key)}
      >
        Close
      </Button>
      <Button
        type="link"
        size="small"
        onClick={() => notificationAPI.destroy()}
      >
        Close All
      </Button>
    </>
  );

  useEffect(() => {
    if (!alertDetails?.content) return;

    notificationAPI.open({
      message: alertDetails?.title,
      description: <CustomMarkdown text={alertDetails?.content} />,
      type: alertDetails?.type,
      duration: alertDetails?.duration,
      btn,
      key: alertDetails?.key,
    });

    pushLogMessages([
      {
        timestamp: Math.floor(Date.now() / 1000),
        level: alertDetails?.type ? alertDetails?.type.toUpperCase() : "",
        message: alertDetails.content,
        type: "NOTIFICATION",
      },
    ]);
  }, [alertDetails]);

  return (
    <ConfigProvider
      direction={window.direction || "ltr"}
      theme={{
        algorithm: darkAlgorithm,
        token: {
          colorPrimary: "#3b82f6",
          colorBgContainer: "#111827",
          colorBgElevated: "#1e293b",
          colorBgLayout: "#0f172a",
          colorBgBase: "#0b1120",
          colorBorder: "#1e293b",
          colorBorderSecondary: "#1e293b",
          colorText: "#e2e8f0",
          colorTextSecondary: "#94a3b8",
          colorTextTertiary: "#64748b",
          colorTextQuaternary: "#475569",
          colorFillSecondary: "#1e293b",
          colorFillTertiary: "#1e293b",
          colorBgTextHover: "#1e293b",
          colorBgTextActive: "#2563eb",
          colorLink: "#3b82f6",
          colorLinkHover: "#60a5fa",
          colorSuccess: "#22c55e",
          borderRadius: 6,
        },
        components: {
          Button: {
            colorPrimary: "#3b82f6",
            colorPrimaryHover: "#2563eb",
            colorPrimaryActive: "#1d4ed8",
          },
          Table: {
            colorBgContainer: "#111827",
            headerBg: "#0f172a",
            headerColor: "#94a3b8",
            rowHoverBg: "#1e293b",
            borderColor: "#1e293b",
            colorText: "#e2e8f0",
          },
          Menu: {
            darkItemBg: "#0b1120",
            darkItemSelectedBg: "#1e293b",
            darkItemHoverBg: "#1e293b",
          },
          Card: {
            colorBgContainer: "#111827",
            colorBorderSecondary: "#1e293b",
          },
          Modal: {
            contentBg: "#111827",
            headerBg: "#111827",
            footerBg: "#111827",
          },
          Input: {
            colorBgContainer: "#0f172a",
            colorBorder: "#1e293b",
            activeBorderColor: "#3b82f6",
            hoverBorderColor: "#3b82f6",
          },
          Select: {
            colorBgContainer: "#0f172a",
            colorBorder: "#1e293b",
            colorBgElevated: "#1e293b",
          },
          Tabs: {
            colorPrimary: "#3b82f6",
            itemSelectedColor: "#ffffff",
            itemHoverColor: "#94a3b8",
            itemColor: "#64748b",
          },
          Tag: {
            colorBgContainer: "#1e293b",
            colorBorder: "#1e293b",
            colorText: "#e2e8f0",
          },
        },
      }}
    >
      <HelmetProvider>
        {isLogoutLoading && (
          <div className="fullscreen-loader">
            <GenericLoader />
          </div>
        )}
        <BrowserRouter>
          <PostHogPageviewTracker />
          <PageTitle title={"Unstract"} />
          {GoogleTagManagerHelper && <GoogleTagManagerHelper />}
          {contextHolder}
          <Router />
        </BrowserRouter>
      </HelmetProvider>
    </ConfigProvider>
  );
}

export { App };
