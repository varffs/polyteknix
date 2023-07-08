const LCD = require('raspberrypi-liquid-crystal');
const lcd = new LCD( 1, 0x27, 16, 2 );

const Gpio = require('onoff').Gpio;
const led = new Gpio(17, 'out');
const button = new Gpio(27, 'in', 'rising', {debounceTimeout: 10});

const ds18b20 = require('ds18b20');

const bme280 = require('bme280');

const axios = require('axios');

axios.defaults.headers.post['api-key'] = 'eccd71298a1210aa99da18743c0d49bbe0992b5049'; // key for list

let data = {
  extTemp: 0,
  intTemp: 0,
  intHumidity: 0,
  intPressure: 0
};

const dataPollingInterval = 60000;
const oneWireTempId = '28-0301a279e8e6';

ds18b20.sensors(function(err, ids) {
  if (err) {
    console.log('ds18b20 error', err);
  }  

  console.log('1w ds18b20 sensors', ids);
});

function formatFloat(number, decimalPlaces = 1) {
  if (number === null) {
    return 0;
  }
  
  let rounded = Math.round((number + Number.EPSILON) * 100) / 100;
  
  return rounded.toFixed(decimalPlaces);
}

function startTest() {
  let index = 0;
  
  lcd.beginSync();
  lcd.displaySync();
  
  // LCD startup text
  lcd.clearSync();
  lcd.printLineSync(0, 'starting up...');
  
  // LED startup flash
  // Toggle the state of the LED connected to GPIO17 every 200ms
  const iv = setInterval(_ => led.writeSync(led.readSync() ^ 1), 200);
  
  // Stop blinking the LED after 15 seconds
  setTimeout(_ => {
    clearInterval(iv); // Stop blinking
    led.writeSync(0);
    
    button.watch((err, value) => {
      if (err) {
        throw err;
      }
      
      console.log('Timer started');
      
      led.writeSync(1);
      setTimeout(() => {
        led.writeSync(0);
        console.log('Timer ended. Notify');
      }, (1000*60*15))    
    });
  }, 15000);
  
  const displayLoop = setInterval(function() {
    lcd.clearSync();
    
    lcd.printLineSync(0, 'int: ' + formatFloat(data.intTemp) + 'c ' + formatFloat(data.intHumidity) + '%');
    lcd.printLineSync(1, 'ext: ' + formatFloat(data.extTemp) + 'c');
  }, 30000);
	
	const bme280Polling = setInterval(async function() {
    bme280.open({
    i2cBusNumber: 1,
    i2cAddress: 0x77,
    humidityOversampling: bme280.OVERSAMPLE.X1,
    pressureOversampling: bme280.OVERSAMPLE.X16,
    temperatureOversampling: bme280.OVERSAMPLE.X2,
    filterCoefficient: bme280.FILTER.F16
  }).then(async sensor => {
      const values = await sensor.read()

      data.intTemp = values.temperature;
      data.intPressure = values.pressure;
      data.intHumidity = values.humidity;
      
      await sensor.close();
    }).catch(err => {
      console.log('bme280 error', err);
    });

  }, dataPollingInterval);
  
/*
  const ds18b20Polling = setInterval(function() {

    ds18b20.temperature(oneWireTempId, function(err, value) { // async
      if (err) {
        console.log('ds18b20 error', err);
        console.log('error.code' , err.code);
        
        if (err.code === 'ENOENT') {
          clearInterval(ds18b20Polling);
        }
        
        return;
      }      
      
      data.extTemp = value;
    });

  }, dataPollingInterval);
*/
  
  const dataPush = setInterval(() => {
    axios.post('http://iotplotter.com/api/v2/feed/408491097864656092', {
      "data": {
        "Internal_Temperature": [
          {
            "value": data.intTemp
          }
        ],
        "Internal_Humidity": [
          {
            "value": data.intHumidity
          }
        ],
        "External_Tempurature": [
          {
            "value": data.extTemp
          }
        ],
        "Atmospheric_Pressure": [
          {
            "value": data.intPressure
          }
        ]
      }
    }).then(response => {
      if (response.status !== 200) {
        console.log(response)  
      }
    });
  }, dataPollingInterval);
}

startTest();

process.on('SIGINT', _ => {
  lcd.noDisplaySync();
  
  process.exit();
});