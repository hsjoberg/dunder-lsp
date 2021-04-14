import { Admin, Resource } from "react-admin";
import BackupIcon from "@material-ui/icons/Backup";
import WidgetsIcon from "@material-ui/icons/Widgets";
import Person from "@material-ui/icons/Person";
import { useMediaQuery } from "@material-ui/core";
import { createMuiTheme } from "@material-ui/core/styles";

import authProvider from "./api/authProvider";
import dataProvider from "./api/dataProvider";

import LnUrlAuthLoginPage from "./login/LnUrlAuthLoginPage";
import Dashboard from "./dashboard/Dashboard";
import { ChannelRequestList, ChannelRequestShow } from "./pages/ChannelRequests";
import { HtlcSettlementList, HtlcSettlementShow } from "./pages/HtlcSettlements";
import { AdminCreate, AdminEdit, AdminList } from "./pages/Admins";
import { PendingChannelList } from "./pages/PendingChannels";

const App = () => {
  const prefersDarkMode = useMediaQuery<typeof theme>("(prefers-color-scheme: dark)");

  const theme = createMuiTheme({
    palette: {
      primary: {
        main: "#7f90f0",
      },
      secondary: {
        dark: "#bc6610",
        main: "#bc6610",
      },
      type: prefersDarkMode ? "dark" : "light",
    },
  });

  return (
    <Admin
      theme={theme}
      loginPage={LnUrlAuthLoginPage}
      disableTelemetry
      authProvider={authProvider}
      dashboard={Dashboard}
      dataProvider={dataProvider}
    >
      <Resource
        icon={BackupIcon}
        options={{
          label: "Channel Requests",
        }}
        name="channelRequests"
        list={ChannelRequestList}
        show={ChannelRequestShow}
      />
      <Resource
        icon={WidgetsIcon}
        options={{
          label: "HTLC Settlements",
        }}
        name="htlcSettlements"
        list={HtlcSettlementList}
        show={HtlcSettlementShow}
      />
      <Resource
        icon={Person}
        options={{
          label: "Pending Channels",
        }}
        name="pendingChannels"
        list={PendingChannelList}
      />
      <Resource
        icon={Person}
        options={{
          label: "Administrators",
        }}
        name="admins"
        list={AdminList}
        create={AdminCreate}
        edit={AdminEdit}
      />
    </Admin>
  );
};

export default App;
