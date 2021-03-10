import React, { CSSProperties, useEffect, useState } from "react";
import { useLogin, Notification, Login } from "react-admin";
import { ThemeProvider } from "@material-ui/styles";
import QRCode from "qrcode.react";

const LnUrlAuthLoginPage: React.FunctionComponent = ({ theme }: any) => {
  const login = useLogin();

  const [bech32, setBech32] = useState("");

  useEffect(() => {
    let ws: WebSocket;
    (async () => {
      // Dummy request. This is apparently needed to make sure WebSocket get session cookie
      await fetch("/admin/api/test", { credentials: "include" });

      const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${wsProtocol}://${window.location.host}/admin/api/login-ws`);
      ws.onmessage = (event) => {
        const response = JSON.parse(event.data);
        if (response.lnurlAuth) {
          console.log(event.data);
          setBech32(response.lnurlAuth);
        } else if (response.status) {
          if (response.status === "OK") {
            login({ username: "username", password: "password" });
          }
        }
      };

      ws.onopen = () => {
        setTimeout(() => {
          ws.send("GET_LNURL");
        }, 50);
      };
    })();

    return () => {
      if (ws) {
        ws.close();
      }
    };
  }, [login]);

  return (
    <ThemeProvider theme={theme}>
      <Login>
        <div style={style}>
          <h4>Login with LNURL-auth</h4>
          {bech32 && (
            <a href={`lightning:${bech32}`}>
              <QRCode size={220} spacing={20} strokeWidth={10} value={bech32.toUpperCase()} />
            </a>
          )}
        </div>
      </Login>

      <Notification />
    </ThemeProvider>
  );
};

const style: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  alignItems: "center",
  paddingTop: 0,
  paddingRight: 20,
  paddingBottom: 20,
  paddingLeft: 20,
};

export default LnUrlAuthLoginPage;
