import build from "../src/app";
const app = build();

test('requests the "/" route', async () => {
  const response = await app.inject({
    method: "GET",
    url: "/",
  });
  expect(response.statusCode).toBe(200);

});

afterAll(() => {
  app.close();
});
