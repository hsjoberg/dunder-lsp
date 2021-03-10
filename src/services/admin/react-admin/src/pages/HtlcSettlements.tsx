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
  Pagination,
  useListFilterContext,
  Filter,
} from "react-admin";
import { Chip, makeStyles } from "@material-ui/core";
import { formatISO } from "date-fns";
import { useEffect } from "react";

const useQuickFilterStyles = makeStyles((theme) => ({
  chip: {
    marginBottom: theme.spacing(1),
  },
}));

const UnclaimedButSettledFilter = ({ label }: any) => {
  const { setFilters, filterValues } = useListFilterContext();

  useEffect(() => {
    setFilters({ ...filterValues, settled: 1, claimed: 0 }, { unclaimedButSettled: 1 });
    return () => {
      setFilters({ ...filterValues, settled: undefined, claimed: undefined }, {});
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const classes = useQuickFilterStyles();
  return <Chip className={classes.chip} label={label} />;
};

const QuickFilter = ({ label }: any) => {
  const classes = useQuickFilterStyles();
  return <Chip className={classes.chip} label={label} />;
};

const HtlcSettlementsFilter: React.FunctionComponent = (props) => (
  <Filter {...props}>
    {/* <QuickFilter source="settled" label="Settled" defaultValue={[1]} /> */}
    <UnclaimedButSettledFilter source="unclaimedButSettled" label="See unclaimed but settled" />
  </Filter>
);

export const HtlcSettlementList: React.FunctionComponent = (props) => {
  return (
    <List
      pagination={<Pagination rowsPerPageOptions={[]} />}
      perPage={20}
      sort={{ field: "channelRequest.start", order: "DESC" }}
      bulkActionButtons={false}
      title="HTLC Settlements"
      filters={<HtlcSettlementsFilter />}
      {...props}
    >
      <Datagrid rowClick="show">
        <ReferenceField
          link="show"
          label="Channel Id"
          source="channelId"
          reference="channelRequests"
        >
          <TextField source="id" />
        </ReferenceField>
        <TextField label="htlcId" source="htlcId" />
        <ReferenceField
          sortBy="channelRequest.status"
          link={false}
          label="Start"
          source="channelId"
          reference="channelRequests"
        >
          <FunctionField source="start" render={(record: any) => formatISO(record.start * 1000)} />
        </ReferenceField>
        <NumberField source="amountSat" align="left" style={{ textAlign: "left" }} />
        <BooleanField source="settled" />
        <BooleanField source="claimed" />
        <ReferenceField
          sortBy="channelRequest.start"
          link={false}
          label="Channel Request status"
          source="channelId"
          reference="channelRequests"
        >
          <TextField source="status" />
        </ReferenceField>
      </Datagrid>
    </List>
  );
};

export const HtlcSettlementShow: React.FunctionComponent = (props) => (
  <Show {...props}>
    <SimpleShowLayout>
      <TextField source="id" />
      <ReferenceField label="Channel Id" source="channelId" reference="channelRequests">
        <TextField source="id" />
      </ReferenceField>
      <NumberField source="amountSat" />
      <BooleanField source="settled" />
      <BooleanField source="claimed" />
    </SimpleShowLayout>
  </Show>
);
