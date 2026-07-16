"use strict";

const { createHandler } = require("../_devourClient");

module.exports = createHandler("/teams/balance", { resolveTeamOwners: true });
