import window from 'global/window';
import videojs from 'video.js';
import dashjs from 'dashjs';

let
  isArray = function(a) {
    return Object.prototype.toString.call(a) === '[object Array]';
  };

const detectIE = function() {
  let ua = window.navigator.userAgent;

  let msie = ua.indexOf('MSIE ');
  if (msie > 0) {
    // IE 10 or older => return version number
    return parseInt(ua.substring(msie + 5, ua.indexOf('.', msie)), 10);
  }

  let trident = ua.indexOf('Trident/');
  if (trident > 0) {
    // IE 11 => return version number
    let rv = ua.indexOf('rv:');
    return parseInt(ua.substring(rv + 3, ua.indexOf('.', rv)), 10);
  }

  let edge = ua.indexOf('Edge/');
  if (edge > 0) {
    // Edge (IE 12+) => return version number
    return parseInt(ua.substring(edge + 5, ua.indexOf('.', edge)), 10);
  }

  // other browser
  return false;
};

/**
 * videojs-contrib-dash
 *
 * Use Dash.js to playback DASH content inside of Video.js via a SourceHandler
 */
class Html5DashJS {
  constructor(source, tech, options) {
    // Get options from tech if not provided for backwards compatibility
    options = options || tech.options_;

    this.player = videojs(options.playerId);
    this.player.dash = this.player.dash || {};

    this.tech_ = tech;
    this.el_ = tech.el();
    this.elParent_ = this.el_.parentNode;
    this.is_live = false;
    this.playback_time = 0;
    this.scte35_events = {};
    this.scte35_fired_events = {};

    // Do nothing if the src is falsey
    if (!source.src) {
      return;
    }

    // While the manifest is loading and Dash.js has not finished initializing
    // we must defer events and functions calls with isReady_ and then `triggerReady`
    // again later once everything is setup
    tech.isReady_ = false;

    if (Html5DashJS.updateSourceData) {
      source = Html5DashJS.updateSourceData(source);
    }

    let manifestSource = source.src;
    this.keySystemOptions_ = Html5DashJS.buildDashJSProtData(source.keySystemOptions);

    if (detectIE() && this.keySystemOptions_['com.widevine.alpha']) {
      // widevine not supported in IE
      this.player.setTimeout(() => {
        this.player.error({
          code: 4, 
          message: this.player.localize(this.player.options_.notSupportedMessage)
        });
      }, 0);
      return this.tech_.triggerReady();
    }

    this.player.dash.mediaPlayer = dashjs.MediaPlayer().create();

    this.mediaPlayer_ = this.player.dash.mediaPlayer;

    // Log MedaPlayer messages through video.js
    if (Html5DashJS.useVideoJSDebug) {
      videojs.log.warn('useVideoJSDebug has been deprecated.' +
        ' Please switch to using beforeInitialize.');
      Html5DashJS.useVideoJSDebug(this.mediaPlayer_);
    }

    if (Html5DashJS.beforeInitialize) {
      Html5DashJS.beforeInitialize(this.player, this.mediaPlayer_);
    }

    // Must run controller before these two lines or else there is no
    // element to bind to.
    this.mediaPlayer_.initialize();

    // Apply any options that are set
    if (options.dash && options.dash.limitBitrateByPortal) {
      this.mediaPlayer_.setLimitBitrateByPortal(true);
    } else {
      this.mediaPlayer_.setLimitBitrateByPortal(false);
    }

    this.mediaPlayer_.attachView(this.el_);

    // Dash.js autoplays by default, video.js will handle autoplay
    this.mediaPlayer_.setAutoPlay(false);

    // Attach the source with any protection data
    this.mediaPlayer_.setProtectionData(this.keySystemOptions_);
    this.mediaPlayer_.attachSource(manifestSource);

    this.initDashHandlers();
    this.fixShowLoader();

    this.tech_.triggerReady();
  }

  /*
   * Add nandlers to dash mediaPlayer
   */
  initDashHandlers() {
    const delete_threshold_time = 60, 
          fire_threshold_time = 0.2,
          scte35_scheme = 'urn:scte:scte35:2014:xml';
    if (this.mediaPlayer_.on) {
      this.mediaPlayer_.on('playbackTimeUpdated', data => {
        this.playback_time = data.time;
        var events_ids = Object.keys(this.scte35_events);
        for (let id of events_ids) {
          if (this.scte35_fired_events[id]) {
            continue;
          }
          let event = this.scte35_events[id];
          let id_event_now = this.playback_time > event.time_start - fire_threshold_time && 
            this.playback_time < event.time_end;
          if (id_event_now) {
            this.scte35_fired_events[id] = true;
            event.left_duration = event.time_end - this.playback_time;
            this.player.trigger('scte35', event);
          }
        }
      });
      this.mediaPlayer_.on('urn:scte:scte35:2014:xml', data => {
        var timescale = data.event.eventStream.timescale || 1;
        this.player.trigger('scte35_event', {
          duration: data.event.duration / timescale,
          id: data.event.id,
          event: data.event
        });
      });

      let first_manifest_updated = true;
      this.mediaPlayer_.on('manifestUpdated', data => {
        if (data.manifest.Error) {
          this.player.error(this.player.localize(data.manifest.Error));
          this.mediaPlayer_.reset();
        }
        if (first_manifest_updated) {
          first_manifest_updated = false;
          this.is_live = this.mediaPlayer_.getActiveStream().getStreamInfo().manifestInfo.isDynamic;
          // hack for double loadstart
          this.tech_.off(
            this.tech_.el_,
            'loadstart', 
            this.tech_.constructor.prototype.successiveLoadStartListener_
          );
        }

        for (let period of data.manifest.Period_asArray) {
          if (!period.EventStream_asArray) {
            continue;
          }
          for (let event_stream of period.EventStream_asArray) {
            if (!event_stream.Event_asArray || event_stream.schemeIdUri !== scte35_scheme) {
              continue;
            }
            let timescale = event_stream.timescale || 1;
            for (let event of event_stream.Event_asArray) {
              if (!event.duration) {
                continue;
              }
              let duration = event.duration / timescale;
              let time_start = event.presentationTime / timescale;
              let time_end = time_start + duration;
              if (time_end + delete_threshold_time < this.playback_time) {
                delete this.scte35_events[event.id];
                delete this.scte35_fired_events[event.id];
              } else {
                this.scte35_events[event.id] = {time_start, time_end, duration, _event: event};
              }
            }
          }
        }
      });
    }
  }

  /*
   * Fix showing loader spinner before canplay
   */
  fixShowLoader() {
    let can_show_seeking = false;
    this.player.on('seeking', () => {
      if (!can_show_seeking) {
        this.player.removeClass('vjs-seeking');
      }
    });
    this.player.on('canplay', () => {
      can_show_seeking = true;
    });
  }

  /*
   * Iterate over the `keySystemOptions` array and convert each object into
   * the type of object Dash.js expects in the `protData` argument.
   *
   * Also rename 'licenseUrl' property in the options to an 'serverURL' property
   */
  static buildDashJSProtData(keySystemOptions) {
    let output = {};

    if (!keySystemOptions || !isArray(keySystemOptions)) {
      return output;
    }

    for (let i = 0; i < keySystemOptions.length; i++) {
      let keySystem = keySystemOptions[i];
      let options = videojs.mergeOptions({}, keySystem.options);

      if (options.licenseUrl) {
        options.serverURL = options.licenseUrl;
        delete options.licenseUrl;
      }

      output[keySystem.name] = options;
    }

    return output;
  }

  duration() {
    return this.is_live ? Infinity : this.el_.duration;
  }

  dispose() {
    if (this.mediaPlayer_) {
      this.mediaPlayer_.reset();
    }

    if (this.player.dash) {
      delete this.player.dash;
    }
  }
}

const canHandleKeySystems = function(source) {
  if (Html5DashJS.updateSourceData) {
    source = Html5DashJS.updateSourceData(source);
  }

  let videoEl = document.createElement('video');
  if (source.keySystemOptions &&
    !(navigator.requestMediaKeySystemAccess ||
      // IE11 Win 8.1
      videoEl.msSetMediaKeys)) {
    return false;
  }

  return true;
};

videojs.DashSourceHandler = function() {
  return {
    canHandleSource: function(source) {
      let dashExtRE = /\.mpd/i;

      if (!canHandleKeySystems(source)) {
        return '';
      }

      if (videojs.DashSourceHandler.canPlayType(source.type)) {
        return 'probably';
      } else if (dashExtRE.test(source.src)) {
        return 'maybe';
      } else {
        return '';
      }
    },

    handleSource: function(source, tech, options) {
      return new Html5DashJS(source, tech, options);
    },

    canPlayType: function(type) {
      return videojs.DashSourceHandler.canPlayType(type);
    }
  };
};

videojs.DashSourceHandler.canPlayType = function(type) {
  let dashTypeRE = /^application\/dash\+xml/i;
  if (dashTypeRE.test(type)) {
    return 'probably';
  }

  return '';
};

// Only add the SourceHandler if the browser supports MediaSourceExtensions
if (!!window.MediaSource) {
  videojs.getComponent('Html5').registerSourceHandler(videojs.DashSourceHandler(), 0);
}

videojs.Html5DashJS = Html5DashJS;
export default Html5DashJS;
