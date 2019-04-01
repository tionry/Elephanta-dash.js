import SwitchRequest from '../SwitchRequest';
import FactoryMaker from '../../../core/FactoryMaker';
import MediaPlayerModel from '../../models/MediaPlayerModel';
import PlaybackController from '../../controllers/PlaybackController';
import {HTTPRequest} from '../../vo/metrics/HTTPRequest';
import EventBus from '../../../core/EventBus';
import Events from '../../../core/events/Events';
import Debug from '../../../core/Debug';

const MINIMUM_BUFFER_S = 6;
const EXP_BUFFER_SIZE = 60;
const UORS_STATE 				= 1;
const REBUFFER_SAFETY_FACTOR 	= 0.9;
const DELAY_TIME = 5.1;
const SAFE_BUFFER_LEVEL = REBUFFER_SAFETY_FACTOR * 4;
const RICH_BUFFER_LEVEL = REBUFFER_SAFETY_FACTOR * 10;

function UorsRule(config) {

	const AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_LIVE = 2;
    const AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_VOD = 3;
    const FIRST_CHUNK = 0;
	let dashMetrics = config.dashMetrics;
	let context = this.context;
    let eventBus = EventBus(context).getInstance();
    let metricsModel = config.metricsModel;
    let log = Debug(context).getInstance().log;
    let uors_factor = 1;
    let uors_factor_constant = 1;

	let instance,
		mediaPlayerModel,
        playbackController;

	function setup() {	

		mediaPlayerModel = MediaPlayerModel(context).getInstance();
        playbackController = PlaybackController(context).getInstance();   
        eventBus.on(Events.BUFFER_EMPTY, onBufferEmpty, instance);
        eventBus.on(Events.PLAYBACK_SEEKING, onPlaybackSeeking, instance);
        //eventBus.on(Events.PERIOD_SWITCH_STARTED, onPeriodSwitchStarted, instance);
	}

	function initializeUorsState() {
		let initialState = {};
		let virtual_queue_z1 = [];
		let virtual_queue_z2 = [];
		let virtual_queue_z3 = [];
		let virtual_queue_g = [];
		let time_slot = [];
		let bandwidth = [];
		let bandwidth_elapsedtime = [];
		let chunk_queue = [];
		let gamma = [];
		let download_time = 0;
		let chunk_number = 0;
		let bitrate_switch = 0;
		let rebuffer_times = 0;
		virtual_queue_g[0] = 0;
		virtual_queue_z1[0] = 0;
		virtual_queue_z2[0] = 0;
		virtual_queue_z3[0] = 0;
		let V = 0.5;
		let alpha1 = 5;
		let alpha2 = 10;
		let alpha3 = 3;
		let gamma_min = 1;
		let gamma_max = 7*Math.log(10);
		let c_1 = 0;
		let c_2 = 0;
		let c_3 = 0;
		//let T_exp_sup = NaN;
		let fragmentDuration = NaN;
		let selected_bitrate = NaN;
		let bitrate_list = [];
		let lastFragmentSuccess = true;

		initialState.state = UORS_STATE;

		initialState.virtual_queue_z1 = virtual_queue_z1;
		initialState.virtual_queue_z2 = virtual_queue_z2;
		initialState.virtual_queue_z3 = virtual_queue_z3;
		initialState.virtual_queue_g = virtual_queue_g;
		initialState.time_slot = time_slot;
		initialState.bandwidth = bandwidth;
		initialState.bandwidth_elapsedtime = bandwidth_elapsedtime;
		initialState.chunk_queue = chunk_queue;
		initialState.gamma = gamma;
		initialState.download_time = download_time;
		initialState.chunk_number = chunk_number;
		initialState.bitrate_switch = bitrate_switch;
		initialState.rebuffer_times = rebuffer_times;
		initialState.V = V;
		initialState.alpha1 = alpha1;
		initialState.alpha2 = alpha2;
		initialState.alpha3 = alpha3;
		initialState.gamma_min = gamma_min;
		initialState.gamma_max = gamma_max;
		initialState.c_1 = c_1;
		initialState.c_2 = c_2;
		initialState.c_3 = c_3;
		initialState.fragmentDuration = fragmentDuration;
		initialState.rebufferSafetyFactor = REBUFFER_SAFETY_FACTOR;
		initialState.minimum_buffer_level = MINIMUM_BUFFER_S;
		initialState.selected_bitrate = selected_bitrate;
		initialState.bitrate_list = bitrate_list;
		initialState.lastFragmentSuccess = lastFragmentSuccess;
		initialState.lastRepresentation = false;
		initialState.constraintsBO = 100;
		initialState.constraintsBS = 100;
		initialState.constraintsRB = 100;

		return initialState;
	}

	function getLastHttpRequests(metrics, count) {
		let allHttpRequests = dashMetrics.getHttpRequests(metrics);
        let httpRequests = [];

        for (let i = allHttpRequests.length - 1; i >= 0 && httpRequests.length < count; --i) {
            let request = allHttpRequests[i];
            if (request.type === HTTPRequest.MEDIA_SEGMENT_TYPE && request._tfinish && request.tresponse && request.trace) {
                httpRequests.push(request);
            }
        }

        return httpRequests;
	}

	function onBufferEmpty() {
		//reset();
	}

	function onPlaybackSeeking() {
        
    }

	function getRecentThroughput(metrics, count) {
		let lastRequests = getLastHttpRequests(metrics, count);
        if (lastRequests.length === 0) {
            return 0;
        }

        let totalInverse = 0;
        //let msg = '';
        for (var i = 0; i < lastRequests.length; ++i) {
            // The RTT delay results in a lower throughput. We can avoid this delay in the calculation, but we do not want to.
            let downloadSeconds = 0.001 * (lastRequests[i]._tfinish.getTime() - lastRequests[i].trequest.getTime());
            let downloadBits = 8 * lastRequests[i].trace.reduce((prev, cur) => (prev + cur.b[0]), 0);
            //if (BOLA_DEBUG) msg += ' ' + (0.000001 * downloadBits).toFixed(3) + '/' + downloadSeconds.toFixed(3) + '=' + (0.000001 * downloadBits / downloadSeconds).toFixed(3) + 'Mbps';
            totalInverse += downloadSeconds / downloadBits;
        }

        //if (BOLA_DEBUG) log('BolaDebug ' + mediaType + ' BolaRule recent throughput = ' + (lastRequests.length / (1000000 * totalInverse)).toFixed(3) + 'Mbps:' + msg);

        return lastRequests.length / totalInverse;
	}
	//auxiliary variables selection 
	function auxiliary_selection(uorsState) {
		let gamma_value;
		let g_count = uorsState.chunk_number - 1;
		if(isNaN(g_count))	g_count = 0;
		let tem_gamma = uorsState.V / uorsState.virtual_queue_g[g_count];
		if(tem_gamma < uorsState.gamma_min) {
			gamma_value = uorsState.gamma_min;
		} else {
			if (tem_gamma > uorsState.gamma_max) {
				gamma_value = uorsState.gamma_max;
			} else {
				gamma_value = tem_gamma;
			}
		}
		return gamma_value;
	}
	//choose optimal bitrate under UORS Metric
	function bitrate_selection(uorsState, exp_bandwidth, buffer_level) {
		let min_val = Number.MAX_VALUE;
		let max_bitrate = 1;
		let current_time_slot_index = uorsState.chunk_number - 1;
		if (current_time_slot_index < 0)	current_time_slot_index = 0;
		let i;
		if(uorsState.chunk_number === FIRST_CHUNK) {
			for(i = 0; i < uorsState.bitrate_list.length; i++) {
				if(uorsState.bitrate_list[i] < exp_bandwidth) {
					max_bitrate = i;
				}
			}

			return max_bitrate;
        }
        if(buffer_level < SAFE_BUFFER_LEVEL) {
        	uors_factor = uors_factor + uors_factor_constant;
        }
        if(buffer_level > RICH_BUFFER_LEVEL) {
        	uors_factor = uors_factor / 2;
        }
        log("Expected bandwidth = " + exp_bandwidth + " buffer_level = " + buffer_level + "uors factor = " + uors_factor);
		log("Constraints weight: BS" + uorsState.constraintsBS + "BO" + uorsState.constraintsBO + "RB" + uorsState.constraintsRB);
		for(i = 0; i < uorsState.bitrate_list.length; i ++) {
			let exp_download_time = uorsState.bitrate_list[i] / exp_bandwidth / Math.pow(REBUFFER_SAFETY_FACTOR,i);
			//if(exp_download_time > uorsState.fragmentDuration)	continue;
			let exp_buffer = buffer_level + uorsState.fragmentDuration - exp_download_time;
			if(exp_download_time > buffer_level || exp_buffer < uors_factor * SAFE_BUFFER_LEVEL)	continue;	
			let exp_y1 = penalty_drift(uorsState.alpha1 * uorsState.constraintsBS/100, uorsState.chunk_queue[uorsState.chunk_number - 1], i);
			let exp_y2 = penalty_rebuffer(uorsState.alpha2 * uorsState.constraintsRB/100, exp_buffer - DELAY_TIME);
			let exp_y3 = penalty_bufferoccupancy(uorsState.alpha3 * uorsState.constraintsBO/100, exp_buffer - DELAY_TIME);
			let exp_T = uorsState.bitrate_list[i] / exp_bandwidth;
			let exp_x = Math.pow(i,2);
			let val = (uorsState.virtual_queue_z1[current_time_slot_index] * exp_y1 + uorsState.virtual_queue_z2[current_time_slot_index] * exp_y2 + uorsState.virtual_queue_z3[current_time_slot_index]*exp_y3 - uorsState.virtual_queue_g[current_time_slot_index] * exp_x)/exp_T;
			log("Penalty of chunk number:" + uorsState.chunk_number + " recycle index: " + i + " value is " + val + "Expected buffer = " + exp_buffer + "exp_download_time: " + exp_download_time);
			if(val < min_val) {
				max_bitrate = i;
            	min_val = val;
			}                
		}
		let selected_bitrate = max_bitrate;
		return selected_bitrate;
	}

	//
	function getMaxIndex(rulesContext) {
		let streamProcessor = rulesContext.getStreamProcessor();
        streamProcessor.getScheduleController().setTimeToLoadDelay(0);
        let switchRequest = SwitchRequest(context).create(SwitchRequest.NO_CHANGE, SwitchRequest.WEAK, {name: UorsRule.__dashjs_factory_name});
        let trackInfo = rulesContext.getTrackInfo();
        let mediaInfo = rulesContext.getMediaInfo();
        let mediaType = mediaInfo.type;
        let metrics = metricsModel.getReadOnlyMetricsFor(mediaType);
        let isDynamic = streamProcessor.isDynamic();        
        let fragmentDuration = trackInfo.fragmentDuration;        

        if(mediaType === 'audio') {
        	return switchRequest;
        }        

        if(metrics.UorsState.length === 0)
        {
        	let initialState = initializeUorsState();
        	initialState.constraintsBO = mediaPlayerModel.getConstraintsBO();
	        initialState.constraintsBS = mediaPlayerModel.getConstraintsBS();
	        initialState.constraintsRB = mediaPlayerModel.getConstraintsRB();
        	metricsModel.updateUorsState(mediaType, initialState);
        }
        let uorsState = metrics.UorsState[0]._s;
        uorsState.fragmentDuration = fragmentDuration;        
        uorsState.bitrate_list = mediaInfo.bitrateList.map(b => b.bandwidth);
        uorsState.constraintsBO = mediaPlayerModel.getConstraintsBO();
        uorsState.constraintsBS = mediaPlayerModel.getConstraintsBS();
        uorsState.constraintsRB = mediaPlayerModel.getConstraintsRB();
        metricsModel.updateUorsState(mediaType, uorsState);

        if (uorsState.chunk_number !== FIRST_CHUNK) {
        	//update virtual queue, dealing with last request.
	        let lastRequests = getLastHttpRequests(metrics, 1);
	        if (lastRequests.length === 0) {
	        	log('UORS: last requests length 0, Chunk_number: ' + uorsState.chunk_number +' selected_bitrate: '+ uorsState.selected_bitrate);
	        	metricsModel.updateUorsState(mediaType, uorsState);
	        	//switchRequest;
	            return;
	        }
	        let lastRequest = lastRequests[0];
	        let lastTimeSlotLength = lastRequest.interval / 1000;
        	//update virtual queue
	        let m_t = lastTimeSlotLength;
	        log('UORS: last time slot length = ' + m_t);
	        let m_y1;
	        if (uorsState.chunk_number < 2) {
	        	m_y1 = 0;
	        } else {
	        	m_y1 = penalty_drift(uorsState.alpha1 * uorsState.constraintsBS/100, uorsState.chunk_queue[uorsState.chunk_number - 1], uorsState.chunk_queue[uorsState.chunk_number - 2]);
	        }
	        let m_y2 = penalty_rebuffer(uorsState.alpha2 * uorsState.constraintsRB/100, uorsState.buffer_occupancy);
	        let m_y3 = penalty_bufferoccupancy(uorsState.alpha3 * uorsState.constraintsBO/100, uorsState.buffer_occupancy);
	        let m_x_m = gain(uorsState.selected_bitrate + 1);
	        uorsState.virtual_queue_z1[uorsState.chunk_number] = Math.max(uorsState.virtual_queue_z1[uorsState.chunk_number - 1] + m_y1 - m_t * uorsState.c_1, 0);
	        uorsState.virtual_queue_z2[uorsState.chunk_number] = Math.max(uorsState.virtual_queue_z2[uorsState.chunk_number - 1] + m_y2 - m_t * uorsState.c_2, 0);
	        uorsState.virtual_queue_z3[uorsState.chunk_number] = Math.max(uorsState.virtual_queue_z3[uorsState.chunk_number - 1] + m_y3 - m_t * uorsState.c_3, 0);
	        uorsState.virtual_queue_g[uorsState.chunk_number] = Math.max(uorsState.virtual_queue_g[uorsState.chunk_number - 1] - m_x_m + m_t * uorsState.gamma, 0);
        }
        //update 
        //let T_exp_sup = Math.max(uorsState.bitrate_list[uorsState.bitrate_list.length - 1]/ uorsState.bitrate_list[0], EXP_BUFFER_SIZE);
        //let y1_exp_sup = uorsState.alpha1 * (uorsState.bitrate_list.length - 1);
        //let y2_exp_sup = uorsState.alpha2 * uorsState.alpha2;
        //let y3_exp_sup = uorsState.alpha3 * EXP_BUFFER_SIZE;
        //uorsState.c_1 = y1_exp_sup / T_exp_sup;
        //uorsState.c_2 = y2_exp_sup / T_exp_sup;
        //uorsState.c_3 = y3_exp_sup / T_exp_sup; 
        uorsState.c_1 = 3;
        uorsState.c_2 = 1;
        uorsState.c_3 = 0.5;       

        //average_utility += uorsState.selected_bitrate;     
        //length measured in chunk number 
        uorsState.buffer_occupancy = dashMetrics.getCurrentBufferLevel(metrics) ? dashMetrics.getCurrentBufferLevel(metrics) : 0;
        let throughputCount = (isDynamic ? AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_LIVE : AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_VOD);
        let expThroughput = getRecentThroughput(metrics, throughputCount);
       /* if(EXP_BUFFER_SIZE - uorsState.buffer_occupancy < MINIMUM_BUFFER_S) {
        	metricsModel.updateUorsState(mediaType, uorsState);
        	callback(null);
        	return;
        }*/

        uorsState.selected_bitrate = bitrate_selection(uorsState, expThroughput, uorsState.buffer_occupancy);
        uorsState.gamma = auxiliary_selection(uorsState);
        uorsState.chunk_queue[uorsState.chunk_number] = uorsState.selected_bitrate;
        switchRequest.value = uorsState.selected_bitrate;
        switchRequest.priorty = switchRequest.DEFAULT;
    	uorsState.chunk_number += 1;
    	log('UORS:Chunk_number: ' + uorsState.chunk_number +' selected_bitrate: '+ uorsState.selected_bitrate);
    	uorsState.lastFragmentSuccess = false;
    	metricsModel.updateUorsState(mediaType, uorsState);
        return switchRequest;        	  
	}

	//penalty defination of rebuffer
	function penalty_rebuffer(alpha, buffer_occupancy) {	
		if(buffer_occupancy < 1)	return Math.pow(alpha,5);	
		return alpha * alpha * Math.log(buffer_occupancy);
	}

	//penalty defination of bitrate drift
	function penalty_drift(alpha,chunk_1,chunk_2) {
		let penalty = alpha * Math.abs(chunk_1 - chunk_2);
		return penalty;
	}

	//penalty defination of buffer occupancy
	function penalty_bufferoccupancy(alpha,buffer_level) {
		if(buffer_level < 0.1) {
			buffer_level = 0;
		}
		let penalty = buffer_level * alpha;
		return penalty;
	}

	/*/benefit defination of attribute values
	function phi_attr(attributes) {
		let result = 0;
		for (var i = attributes.length - 1; i >= 0; i--) {
			resutl += attributes[i];
		}
		return result;
	}*/

	//efficient gain of amounts of data,measured in bitrate
	function gain(bitrates) {
		return Math.log(bitrates);
	}

	function reset() {
        eventBus.off(Events.BUFFER_EMPTY, onBufferEmpty, instance);
        eventBus.off(Events.PLAYBACK_SEEKING, onPlaybackSeeking, instance);
        //eventBus.off(Events.PERIOD_SWITCH_STARTED, onPeriodSwitchStarted, instance);
        setup();
    }

	instance = {
		getMaxIndex: getMaxIndex,
		reset: reset
	};
	setup();
	return instance;
}

UorsRule.__dashjs_factory_name = 'UorsRule';
let factory = FactoryMaker.getClassFactory(UorsRule);
export default factory;