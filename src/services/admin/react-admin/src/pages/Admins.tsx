import React, { useEffect, useRef, useState } from "react";
import {
  Create,
  Datagrid,
  Edit,
  List,
  Show,
  SimpleForm,
  SimpleShowLayout,
  TextField,
  TextInput,
  useInput,
} from "react-admin";
import QRCode from "qrcode.react";
import { Typography } from "@material-ui/core";

export const AdminEdit: React.FunctionComponent = (props) => (
  <Edit {...props}>
    <SimpleForm>
      <TextInput disabled style={{ width: 600 }} source="id" />
      <TextInput required style={{ width: 600 }} source="name" />
    </SimpleForm>
  </Edit>
);

export const AdminList: React.FunctionComponent = (props) => (
  <List {...props}>
    <Datagrid rowClick="edit">
      <TextField source="name" />
      <TextField source="pubkey" />
    </Datagrid>
  </List>
);

const PubkeyField: React.FunctionComponent<any> = ({ value, ...props }: any) => {
  const {
    input: { name, onChange, ...rest },
    meta: { touched, error },
    isRequired,
  } = useInput(props);

  useEffect(() => {
    onChange({ target: { value } });
  }, [value]);

  return (
    <TextInput
      source={props.source}
      name={name}
      label={props.label}
      onChange={onChange}
      error={!!(touched && error)}
      helperText={touched && error}
      required={isRequired}
      {...props}
    />
  );
};

export const AdminCreate: React.FunctionComponent = (props) => {
  const [bech32, setBech32] = useState("");
  const [pubkey, setPubkey] = useState("");
  const pubkeyInput = useRef<any>();

  useEffect(() => {
    let ws: WebSocket;
    (async () => {
      ws = new WebSocket("ws://localhost:8080/admin/api/create-admin-lnurl-auth-ws");
      ws.onmessage = (event) => {
        const response = JSON.parse(event.data);
        if (response.lnurlAuth) {
          setBech32(response.lnurlAuth);
        } else if (response.pubkey) {
          setPubkey(response.pubkey);
        }
      };
    })();

    return () => {
      if (ws) {
        ws.close();
      }
    };
  }, []);

  useEffect(() => {}, []);

  console.log(pubkey);
  return (
    <Create {...props}>
      <SimpleForm redirect="list">
        {bech32 && (
          <>
            <Typography>
              Scan the LNURL-auth QR code of the device you want to give admin access to.
            </Typography>
            <QRCode size={225} includeMargin={true} value={bech32.toUpperCase()} />
          </>
        )}
        <PubkeyField required source="pubkey" value={pubkey} />
        <TextInput required source="name" />
      </SimpleForm>
    </Create>
  );
};
