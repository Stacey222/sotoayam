const response = await fetch("http://127.0.0.1:3000/api/admin/collaboration-rules", {
  headers: { "x-admin-api-key": process.env.ADMIN_API_KEY },
});
const payload = await response.json().catch(() => ({}));
const rules = Array.isArray(payload.data) ? payload.data : [];
const confirmed = rules.length === 1
  && rules[0]?.source_division?.code === "ONPAGE_B2C"
  && rules[0]?.target_division?.code === "CONTENT_CREATOR"
  && rules[0]?.allowed === true
  && rules[0]?.requires_approval === false
  && rules[0]?.active === true;
console.log(`PROTECTED_API_STATUS=${response.status}`);
console.log(`COLLABORATION_RULE_COUNT=${rules.length}`);
console.log(`CONFIRMED_SEED=${confirmed ? "PASS" : "FAIL"}`);
if (response.status !== 200 || !confirmed) process.exitCode = 1;
