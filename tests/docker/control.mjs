const response = await fetch("http://127.0.0.1:6001", {
  method: "POST",
  body: process.argv[2] ?? "{}",
});
console.log(await response.text());
