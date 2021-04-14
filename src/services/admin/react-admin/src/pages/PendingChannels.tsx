import * as React from "react";
import {
  List,
  Datagrid,
  TextField,
  ReferenceField,
  NumberField,
  BooleanField,
  Show,
  SimpleShowLayout,
  FunctionField,
} from "react-admin";
import { channelPointField } from "../common/ChannelPointField";

export const PendingChannelList: React.FunctionComponent = (props) => (
  <List {...props}>
    <Datagrid rowClick="edit">
      <FunctionField
        label="Channel Point"
        source="id"
        render={({ channelPoint }: any) => channelPointField(channelPoint)}
      />
      <TextField source="remoteNodePub" label="Pubkey" />
      <NumberField source="localBalance" label="Local Balance" />
      <NumberField source="remoteBalance" label="Remote Balance" />
      <TextField source="capacity" label="Capacity" />
      <NumberField source="commitFee" label="Fee" />
    </Datagrid>
  </List>
);
