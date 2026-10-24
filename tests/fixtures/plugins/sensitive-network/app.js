async function getWeather() {
  const res = await fetch('https://api.weather.example.com/today');
  return res.json();
}
getWeather();
