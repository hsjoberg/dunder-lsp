import React, { useEffect } from "react";
import {
  List,
  Datagrid,
  TextField,
  TextInput,
  Filter,
  SimpleList,
  NumberField,
  Show,
  SimpleShowLayout,
  FunctionField,
  BooleanField,
  TopToolbar,
  ListButton,
  useListFilterContext,
  Pagination,
} from "react-admin";
import { useMediaQuery, Chip, makeStyles, Link } from "@material-ui/core";
import { formatISO } from "date-fns";
import { channelPointField } from "../common/ChannelPointField";

const ChannelRequestTitle: React.FunctionComponent = ({ record }: any) => {
  return <span>Channel Request {record ? `${record.channelId}` : ""}</span>;
};

const useQuickFilterStyles = makeStyles((theme) => ({
  chip: {
    marginBottom: theme.spacing(1),
  },
}));

// const TestFilter = ({ label }: any) => {
//   const { setFilters, filterValues } = useListFilterContext();

//   useEffect(() => {
//     setFilters({ ...filterValues, status: "REGISTERED", expired: false }, { testing: 1 });
//     return () => {
//       setFilters({ ...filterValues, status: undefined, expired: undefined }, {});
//     };
//   }, []); // eslint-disable-line react-hooks/exhaustive-deps

//   const classes = useQuickFilterStyles();
//   return <Chip className={classes.chip} label={label} />;
// };

const QuickFilter = ({ label }: any) => {
  const classes = useQuickFilterStyles();
  return <Chip className={classes.chip} label={label} />;
};

const ChannelRequestFilter: React.FunctionComponent = (props) => (
  <Filter {...props}>
    <TextInput source="channelId" alwaysOn label="Channel Id" defaultValue="" />
    <TextInput source="pubkey" alwaysOn label="Pubkey" defaultValue="" />
    <TextInput source="status" label="Status" defaultValue="" />
    <QuickFilter source="expired" label="Open channel requests" defaultValue={["REGISTERED"]} />
    {/* <TestFilter source="testing" label="test filter" /> */}
  </Filter>
);

export const ChannelRequestList: React.FunctionComponent = (props) => {
  const isSmall = useMediaQuery((theme: any) => theme.breakpoints.down("sm"));

  return (
    <List
      pagination={<Pagination rowsPerPageOptions={[]} />}
      perPage={20}
      sort={{ field: "start", order: "DESC" }}
      bulkActionButtons={false}
      filters={<ChannelRequestFilter />}
      title="Channel Requests"
      {...props}
    >
      {isSmall ? (
        <SimpleList
          primaryText={(record) => record.id as any}
          secondaryText={(record) => `${record.status}`}
          tertiaryText={(record) => new Date(record.start * 1000).toLocaleString()}
        />
      ) : (
        <Datagrid rowClick="show">
          <TextField label="channelId" source="id" />
          <TextField source="pubkey" />
          {/* <TextField source="preimage" /> */}
          <TextField source="status" />
          <FunctionField source="start" render={(record: any) => formatISO(record.start * 1000)} />
          <TextField source="expire" />
          <BooleanField source="expired" />
          <NumberField label="Sat" source="expectedAmountSat" />
        </Datagrid>
      )}
    </List>
  );
};

const PostEditActions: React.FunctionComponent = ({ basePath, data }: any) => (
  <TopToolbar>
    <ListButton basePath={basePath} record={data} />
  </TopToolbar>
);

export const ChannelRequestShow: React.FunctionComponent = (props) => {
  return (
    <>
      <Show title={<ChannelRequestTitle />} actions={<PostEditActions />} {...props}>
        <SimpleShowLayout>
          <TextField label="channelId" source="id" />
          <TextField source="pubkey" />
          <TextField source="preimage" />
          <FunctionField
            label="Channel Point"
            source="channelPoint"
            render={({ channelPoint }: any) => channelPointField(channelPoint)}
          />
          <TextField source="status" />
          <FunctionField source="start" render={(record: any) => formatISO(record.start * 1000)} />
          <NumberField source="expire" />
          <NumberField source="expectedAmountSat" />
        </SimpleShowLayout>
      </Show>
    </>
  );
};
