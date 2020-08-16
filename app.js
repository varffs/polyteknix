const LCD = require('raspberrypi-liquid-crystal');
const ds18b20 = require('ds18b20');
const bme280 = require('bme280');

class App {
  constructor() {
    this.dataPollingInterval = 5000; // ms interval for data polling
    this.screenUpdateInterval = 1000; // ms interval for updating the lcd screen
    this.dataPostInterval = 60000; // ms interval for posting data to server

    this.oneWireSensorId = '28-0301a279e8e6';

    this.lcd = new LCD( 1, 0x27, 16, 2 );

    this.data = {
      temperature: {
        internal: 0,
        external: 0
      },
      humidity: 0,
      pressure: 0
    }
  }

  init() {
    const _this = this;

    _this.bme280Polling = setInterval(function() {
      _this.pollBme80();
    }, _this.dataPollingInterval);

    _this.ds18b20Polling = setInterval(function() {
      _this.pollds18b20();
    }, _this.dataPollingInterval);

    _this.lcd.beginSync(); // init lcd

    _this.displayUpdate = setInterval(function() {
      _this.updateDisplay();
    }, _this.screenUpdateInterval);

    _this.postDataInterval = setInterval(function() {
      _this.postData();
    }, _this.dataPostInterval);

    _this.bind();
  }

  bind() {
    const _this = this;

    process.on('SIGINT', _ => {
      _this.lcd.clearSync().noDisplaySync();

      clearInterval(_this.bme280Polling);
      clearInterval(_this.ds18b20Polling);
      clearInterval(_this.displayUpdate);
      clearInterval(_this.postDataInterval);

      process.exit(0);
    });
  }

  async pollBme80() {
    const _this = this;

    bme280.open({
      i2cBusNumber: 1,
      i2cAddress: 0x76,
      humidityOversampling: bme280.OVERSAMPLE.X1,
      pressureOversampling: bme280.OVERSAMPLE.X16,
      temperatureOversampling: bme280.OVERSAMPLE.X2,
      filterCoefficient: bme280.FILTER.F16
    }).then(async sensor => {
      const reading = await sensor.read();

      _this.data.temperature.internal = reading.temperature;
      _this.data.humidity = reading.humidity;
      _this.data.pressure = reading.pressure;

      await sensor.close();
    }).catch(console.log);
  }

  async pollds18b20() {
    const _this = this;

    ds18b20.temperature(_this.oneWireSensorId, function(error, value) {
      if (error) {
        console.log('ds18b20 error', error);
      }

      _this.data.temperature.external = value;
    });
  }

  updateDisplay() {
    const _this = this;

    _this.lcd.printLineSync(0, _this.getSmileyStatus() + ' ' +  _this.formatFloat(_this.data.temperature.internal, 1) + 'c ' + _this.formatFloat(_this.data.humidity, 1) + '%');
    _this.lcd.printLineSync(1, _this.formatFloat(_this.data.pressure, 0) + 'hPa ' + _this.formatFloat(_this.data.temperature.external, 1) + 'c ');
  }

  postData() {
    const _this = this;

    console.log('Posting this data to server', _this.data);
  }

  getSmileyStatus() {
    if (this.data.temperature.internal > 33) {
      return ':!';
    } else if (this.data.temperature.internal > 30) {
      return ':/';
    } else if (this.data.temperature.internal > 23) {
      return ':]';
    } else if (this.data.temperature.internal > 18) {
      return ':|';
    } else {
      return ':(';
    }
  }

  formatFloat(number, decimalPlaces = 1) {
    return (Math.round((number + Number.EPSILON) * 100) / 100).toFixed(decimalPlaces);
  }

  getRandomInteger(minimum, maximum) {
    return Math.floor(Math.random() * (maximum - minimum)) + minimum;
  }
}

const app = new App();
app.init();