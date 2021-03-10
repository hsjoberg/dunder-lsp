// eslint-disable-next-line import/no-anonymous-default-export
export default {
  // called when the user attempts to log in
  login: () => {
    console.log("login");
    localStorage.setItem("authenticated", "authenticated");
    // accept all username/password combinations
    return Promise.resolve();
  },
  // called when the user clicks on the logout button
  logout: async () => {
    await fetch("/admin/api/logout");
    localStorage.removeItem("authenticated");
    return;
  },
  // called when the API returns an error
  checkError: ({ status }: any) => {
    if (status === 401 || status === 403) {
      localStorage.removeItem("username");
      return Promise.reject();
    }
    return Promise.resolve();
  },
  // called when the user navigates to a new location, to check for authentication
  checkAuth: () => {
    return localStorage.getItem("authenticated") ? Promise.resolve() : Promise.reject();
  },
  // called when the user navigates to a new location, to check for permissions / roles
  getPermissions: () => Promise.resolve(),
};
